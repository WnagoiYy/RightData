import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createImportCsv,
  hasPermission,
  normalizeParsedRows,
  parseJobProgress,
  settleOperation,
  stableOperation,
  stableRowFilter,
} from '../../client/src/features/data/data-utils.ts'
import type { DataField, ImportMapping } from '../../client/src/features/data/types.ts'

test('permission helper defers to server when permissions are unavailable', () => {
  assert.equal(hasPermission(undefined, 'data.read'), true)
  assert.equal(hasPermission([], 'data.read'), false)
  assert.equal(hasPermission(['*'], 'schema.manage'), true)
  assert.equal(hasPermission(['data.read'], 'data.read'), true)
})

test('parsed rows reject invalid headers and infer common types', () => {
  const parsed = normalizeParsedRows('sales.xlsx', 'Sheet1', [
    ['id', 'amount', 'active', 'day'],
    [1, 12.5, true, '2026-10-23'],
    [2, 9.2, false, '2026-10-24'],
  ])
  assert.deepEqual(parsed.headers, ['id', 'amount', 'active', 'day'])
  assert.deepEqual(parsed.inferredTypes, ['BIGINT', 'DOUBLE', 'BOOLEAN', 'DATE'])
  assert.throws(() => normalizeParsedRows('bad.csv', 'Sheet1', [['id', 'ID'], [1, 2]]), /表头不能重复/)
})

test('record writes use primary key or a single unique field', () => {
  const fields: DataField[] = [
    { name: 'tenant', dataType: 'VARCHAR', nullable: false, primaryKey: true, ordinal: 1 },
    { name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true, ordinal: 2 },
    { name: 'email', dataType: 'VARCHAR', nullable: false, unique: true, ordinal: 3 },
  ]
  assert.deepEqual(stableRowFilter({ tenant: 'gz', id: '7', email: 'a@example.test' }, fields), {
    logic: 'and',
    rules: [
      { field: 'tenant', op: 'eq', value: 'gz' },
      { field: 'id', op: 'eq', value: '7' },
    ],
  })
  assert.equal(stableRowFilter({ tenant: 'gz' }, fields), undefined)
})

test('strict import CSV preserves column mapping, nulls and quoting', async () => {
  const parsed = normalizeParsedRows('source.xlsx', 'Sheet1', [
    ['source_name', 'amount', 'note'],
    ['a,b', null, '\\N'],
    ['"quoted"', 12.5, ''],
  ])
  const mappings: ImportMapping[] = [
    { source: 'source_name', target: 'name', dataType: 'VARCHAR', included: true },
    { source: 'amount', target: 'amount', dataType: 'DOUBLE', included: true },
    { source: 'note', target: 'note', dataType: 'VARCHAR', included: true },
  ]
  const file = createImportCsv(parsed, mappings)
  const text = await file.text()
  assert.equal(file.name, 'source.csv')
  assert.equal(text, 'name,amount,note\n"a,b",\\N,"\\N"\n"""quoted""",12.5,')
  assert.equal(text.includes('\r'), false)

  const parsedCells = text.split('\n').map((line) => {
    const cells: Array<{ value: string | null; quoted: boolean }> = []
    let value = ''
    let quoted = false
    let inQuotes = false
    for (let index = 0; index <= line.length; index += 1) {
      const character = line[index]
      if (inQuotes && character === '"' && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        inQuotes = !inQuotes
        quoted = true
      } else if ((character === ',' && !inQuotes) || index === line.length) {
        cells.push({ value: !quoted && value === '\\N' ? null : value, quoted })
        value = ''
        quoted = false
      } else {
        value += character
      }
    }
    return cells
  })
  assert.deepEqual(parsedCells[1], [
    { value: 'a,b', quoted: true },
    { value: null, quoted: false },
    { value: '\\N', quoted: true },
  ])
  assert.deepEqual(parsedCells[2][2], { value: '', quoted: false })
})

test('pending writes reuse their idempotency key for a stable snapshot', () => {
  const first = stableOperation('test-record', { table: 'orders', values: { b: 2, a: 1 } })
  const retry = stableOperation('test-record', { values: { a: 1, b: 2 }, table: 'orders' })
  assert.equal(retry.key, first.key)
  settleOperation(first)
  const nextWrite = stableOperation('test-record', { table: 'orders', values: { a: 1, b: 2 } })
  assert.notEqual(nextWrite.key, first.key)
  settleOperation(nextWrite)
})

test('job progress accepts server objects and encoded JSON', () => {
  assert.deepEqual(parseJobProgress({ phase: 'complete', percent: 100 }), { phase: 'complete', percent: 100 })
  assert.deepEqual(parseJobProgress('{"phase":"running"}'), { phase: 'running', percent: undefined })
})
