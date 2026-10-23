import { createHash } from 'node:crypto'
import { test, expect } from '../../client/node_modules/@playwright/test/index.mjs'
import { installNativeMock } from './mock-native.mjs'

function exportArtifact() {
  const prefix = [
    JSON.stringify({ type: 'schema', fields: [
      { name: '编号', dataType: 'BIGINT', nullable: false, primaryKey: true, ordinal: 0 },
      { name: '地市', dataType: 'VARCHAR', nullable: false, ordinal: 1 },
      { name: '产品', dataType: 'VARCHAR', nullable: true, ordinal: 2 },
      { name: '金额', dataType: 'DECIMAL(18,2)', nullable: true, ordinal: 3 },
    ] }),
    JSON.stringify({ type: 'chunk', sequence: 0, rows: [['9007199254740993', '贵阳', '权益产品 A', '1280.50']] }),
  ].join('\n') + '\n'
  const sha256 = createHash('sha256').update(prefix).digest('hex')
  return Array.from(new TextEncoder().encode(`${prefix}${JSON.stringify({ type: 'complete', complete: true, totalRows: 1, sha256 })}\n`))
}

test('completed export records Excel and NDJSON file-generation outcomes', async ({ page }) => {
  const control = await installNativeMock(page)
  await page.goto('/#data')
  const artifact = exportArtifact()
  await page.evaluate((bytes) => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const input = args?.request || {}
      if (command === 'api_download_read') {
        if (window.__rightdataFailExportRead) throw { code: 'artifact_corrupt', message: '导出文件损坏' }
        return bytes
      }
      if (command === 'api_request' && input.path === '/api/v1/export-jobs') {
        return { status: 200, headers: {}, data: { code: 'ok', message: '', data: { jobId: 'export-test', state: 'queued' } } }
      }
      if (command === 'api_request' && input.path === '/api/v1/jobs/export-test') {
        return { status: 200, headers: {}, data: { code: 'ok', message: '', data: { id: 'export-test', kind: 'export', datasetId: 'rights-db', state: 'succeeded', progress: { phase: 'complete', percent: 100 }, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:01Z', expiresAt: '2026-10-24T00:00:00Z' } } }
      }
      return original(command, args)
    }
  }, artifact)

  await page.getByRole('button', { name: /全量导出/ }).click()
  await expect(page.getByRole('button', { name: /保存 Excel/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'NDJSON' })).toBeVisible()
  await page.getByRole('button', { name: /保存 Excel/ }).click()
  await expect.poll(() => control.saves.length).toBe(1)
  expect(control.saves[0].suggestedName).toMatch(/^权益明细-\d{8}\.xlsx$/)
  expect(control.saves[0].bytes.slice(0, 4)).toEqual([80, 75, 3, 4])
  await expect.poll(() => control.exportEvents.length).toBe(1)
  expect(control.exportEvents[0]).toEqual({ jobId: 'export-test', outcome: 'success' })

  await page.getByRole('button', { name: 'NDJSON' }).click()
  await expect.poll(() => control.downloads.length).toBe(1)
  await expect.poll(() => control.exportEvents.length).toBe(2)
  expect(control.exportEvents[1]).toEqual({ jobId: 'export-test', outcome: 'success' })

  await page.evaluate(() => { window.__rightdataFailExportRead = true })
  await page.getByRole('button', { name: /保存 Excel/ }).click()
  await expect.poll(() => control.exportEvents.length).toBe(3)
  expect(control.exportEvents[2]).toEqual({ jobId: 'export-test', outcome: 'failed' })

  control.failNext = { code: 'canceled', message: '已取消保存' }
  await page.getByRole('button', { name: 'NDJSON' }).click()
  await expect.poll(() => control.exportEvents.length).toBe(4)
  expect(control.exportEvents[3]).toEqual({ jobId: 'export-test', outcome: 'canceled' })
})
