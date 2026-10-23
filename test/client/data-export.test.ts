import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from '../../client/node_modules/xlsx/dist/xlsx.full.min.js'
import { exportNdjsonToXlsx } from '../../client/src/features/data/export-utils.ts'

async function fixture(corrupt = false): Promise<Uint8Array> {
  const prefix = [
    JSON.stringify({ type: 'schema', fields: [
      { name: 'id', dataType: 'BIGINT', nullable: false, ordinal: 1 },
      { name: 'amount', dataType: 'DECIMAL(24,4)', nullable: false, ordinal: 2 },
      { name: 'quantity', dataType: 'INTEGER', nullable: false, ordinal: 3 },
      { name: 'ratio', dataType: 'DOUBLE', nullable: false, ordinal: 4 },
      { name: 'note', dataType: 'VARCHAR', nullable: true, ordinal: 5 },
    ] }),
    '{"type":"chunk","sequence":0,"rows":[[9007199254740993,12345678901234567890.1234,42,0.125,"精确"],["-9007199254740994","0.0100",7,1.5,null]]}',
  ].join('\n') + '\n'
  const encoded = new TextEncoder().encode(prefix)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  const badHash = `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`
  const footer = JSON.stringify({ type: 'complete', complete: true, totalRows: 2, sha256: corrupt ? badHash : hash })
  return new TextEncoder().encode(`${prefix}${footer}\n`)
}

test('NDJSON export becomes a lossless multi-sheet workbook', async () => {
  const result = await exportNdjsonToXlsx(await fixture(), '精确值/导出', { maxRowsPerSheet: 1 })
  assert.equal(result.rowCount, 2)
  assert.equal(result.sheetCount, 2)

  const workbook = XLSX.read(result.bytes, { type: 'array', raw: true })
  assert.deepEqual(workbook.SheetNames, ['精确值_导出', '精确值_导出_2'])
  const first = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: null }) as unknown[][]
  const second = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[1]], { header: 1, raw: true, defval: null }) as unknown[][]
  assert.deepEqual(first[1], ['9007199254740993', '12345678901234567890.1234', 42, 0.125, '精确'])
  assert.deepEqual(second[1], ['-9007199254740994', '0.0100', 7, 1.5, null])
})

test('NDJSON export rejects a mismatched artifact digest', async () => {
  const bytes = await fixture(true)
  await assert.rejects(() => exportNdjsonToXlsx(bytes, 'invalid'), /完整性校验失败/)
})
