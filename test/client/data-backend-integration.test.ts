import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import * as XLSX from '../../client/node_modules/xlsx/dist/xlsx.full.min.js'
import { createImportCsv, normalizeParsedRows } from '../../client/src/features/data/data-utils.ts'
import { exportNdjsonToXlsx } from '../../client/src/features/data/export-utils.ts'
import type { ImportMapping } from '../../client/src/features/data/types.ts'

type SessionFile = {
  address: string
  username: string
  password: string
}

type Envelope<T> = {
  code: string
  message: string
  data: T
}

type Job = {
  id: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired'
  error?: string
  result?: unknown
}

const workspace = path.resolve(import.meta.dirname, '..', '..')
const resultPath = path.join(workspace, 'test', 'results', 'client-data-integration.json')

function key(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

async function request<T>(base: string, token: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  const response = await fetch(`${base}${pathname}`, { ...init, headers })
  const value = await response.json() as Envelope<T>
  if (!response.ok || value.code !== 'ok') {
    throw new Error(`${pathname}: ${value.code || response.status} ${value.message || 'request failed'}`)
  }
  return value.data
}

async function waitForJob(base: string, token: string, id: string): Promise<Job> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const job = await request<Job>(base, token, `/api/v1/jobs/${encodeURIComponent(id)}`)
    if (['succeeded', 'failed', 'canceled', 'expired'].includes(job.state)) return job
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`job ${id} did not finish before timeout`)
}

test('real backend supports the complete data workspace flow', { timeout: 60_000 }, async () => {
  const session = JSON.parse(await readFile(path.join(workspace, 'test', 'runtime', 'client-integration-session.json'), 'utf8')) as SessionFile
  const run = crypto.randomUUID().slice(0, 8)
  const databaseName = `client-data-${run}.duckdb`
  const table = `exact_values_${run}`
  const databasePassword = `Integration-${crypto.randomUUID()}`
  const exactId = '9007199254740993'
  const exactDecimal = '12345678901234567890.1234'
  const idempotencyMode = process.env.RIGHTDATA_IDEMPOTENCY_MODE === 'diagnosticFallback' ? 'diagnosticFallback' : 'headerOnly'
  let token = ''
  let databaseId = ''
  const checks: string[] = []

  try {
    const login = await request<{ accessToken: string }>(session.address, '', '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: session.username, password: session.password, remember: false }),
    })
    token = login.accessToken

    const database = await request<{ id: string }>(session.address, token, '/api/v1/data-files', {
      method: 'POST',
      body: JSON.stringify({ name: databaseName, password: databasePassword }),
    })
    databaseId = database.id
    checks.push('database_created')

    const schemaKey = key('integration-schema')
    await request(session.address, token, `/api/v1/datasets/${encodeURIComponent(databaseId)}/schema:mutate`, {
      method: 'POST',
      headers: { 'Idempotency-Key': schemaKey },
      body: JSON.stringify({
        ...(idempotencyMode === 'diagnosticFallback' ? { idempotencyKey: schemaKey } : {}),
        action: 'create_table',
        table,
        fields: [
          { name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true },
          { name: 'amount', dataType: 'DECIMAL(24,4)', nullable: false },
          { name: 'label', dataType: 'VARCHAR', nullable: false },
          { name: 'note', dataType: 'VARCHAR', nullable: true },
        ],
      }),
    })
    checks.push('table_created')

    const parsed = normalizeParsedRows('exact-values.xlsx', 'Sheet1', [
      ['id', 'amount', 'label', 'note'],
      [exactId, exactDecimal, '精确值', null],
      ['7', '0.0100', '空字符串', ''],
    ])
    const mappings: ImportMapping[] = parsed.headers.map((source, index) => ({
      source,
      target: source,
      dataType: ['BIGINT', 'DECIMAL(24,4)', 'VARCHAR', 'VARCHAR'][index],
      included: true,
    }))
    const csv = createImportCsv(parsed, mappings)
    const csvText = await csv.text()
    assert.equal(csvText.includes('\r'), false)
    assert.match(csvText, /精确值,\\N\n/)

    const form = new FormData()
    form.set('purpose', 'import')
    form.set('file', csv, csv.name)
    const upload = await request<{ uploadId: string }>(session.address, token, '/api/v1/uploads', { method: 'POST', body: form })
    checks.push('strict_csv_uploaded')

    const submittedImport = await request<{ jobId: string }>(session.address, token, '/api/v1/import-jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': key('integration-import') },
      body: JSON.stringify({
        datasetId: databaseId,
        table,
        uploadId: upload.uploadId,
        mode: 'append',
        columns: parsed.headers,
      }),
    })
    const importJob = await waitForJob(session.address, token, submittedImport.jobId)
    assert.equal(importJob.state, 'succeeded', importJob.error)
    checks.push('import_job_succeeded')

    const query = await request<{ total: number; rows: Array<Record<string, unknown>> }>(
      session.address,
      token,
      `/api/v1/datasets/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(table)}/query`,
      {
        method: 'POST',
        body: JSON.stringify({
          fields: parsed.headers,
          filters: [{ field: 'id', op: 'eq', value: exactId }],
          limit: 10,
          offset: 0,
        }),
      },
    )
    assert.equal(query.total, 1)
    assert.equal(query.rows[0]?.id, exactId)
    assert.equal(query.rows[0]?.amount, exactDecimal)
    assert.equal(query.rows[0]?.note, null)
    checks.push('exact_bigint_and_decimal_queried')

    const submittedExport = await request<{ jobId: string }>(session.address, token, '/api/v1/export-jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': key('integration-export') },
      body: JSON.stringify({ datasetId: databaseId, table, fields: parsed.headers, orderBy: [{ field: 'id', direction: 'ASC' }] }),
    })
    const exportJob = await waitForJob(session.address, token, submittedExport.jobId)
    assert.equal(exportJob.state, 'succeeded', exportJob.error)

    const exported = await fetch(`${session.address}/api/v1/jobs/${encodeURIComponent(submittedExport.jobId)}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(exported.ok, true)
    const exportBytes = new Uint8Array(await exported.arrayBuffer())
    const ndjson = new TextDecoder().decode(exportBytes)
    const records = ndjson.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.equal(records[0]?.type, 'schema')
    assert.equal(records.at(-1)?.complete, true)
    const exportedRows = records.filter((record) => record.type === 'chunk').flatMap((record) => record.rows as unknown[][])
    assert.equal(exportedRows.length, 2)
    assert.equal(exportedRows.some((row) => row[0] === exactId && row[1] === exactDecimal), true)
    checks.push('export_job_downloaded_losslessly')

    const generated = await exportNdjsonToXlsx(exportBytes, table)
    const workbook = XLSX.read(generated.bytes, { type: 'array', raw: true })
    const excelRows = workbook.SheetNames.flatMap((name) => (
      XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null }) as unknown[][]
    ).slice(1))
    assert.equal(excelRows.some((row) => row[0] === exactId && row[1] === exactDecimal), true)
    checks.push('xlsx_generated_losslessly')

    await writeFile(resultPath, `${JSON.stringify({ status: 'passed', ranAt: new Date().toISOString(), idempotencyMode, checks, importedRows: 2, exportedRows: exportedRows.length }, null, 2)}\n`)
  } catch (error) {
    await writeFile(resultPath, `${JSON.stringify({ status: 'failed', ranAt: new Date().toISOString(), idempotencyMode, checks, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
    throw error
  } finally {
    if (token && databaseId) {
      try {
        await request(session.address, token, `/api/v1/data-files/${encodeURIComponent(databaseId)}`, { method: 'DELETE' })
      } catch {
        // Preserve the primary test result if cleanup cannot complete.
      }
    }
  }
})
