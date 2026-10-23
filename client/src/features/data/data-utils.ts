import type { DataField, DataFilter, FilterOperator, ImportMapping, ParsedDataFile } from './types'

export const DATA_TYPES = [
  'VARCHAR',
  'BOOLEAN',
  'INTEGER',
  'BIGINT',
  'DOUBLE',
  'DECIMAL(18,2)',
  'DATE',
  'TIMESTAMP',
  'UUID',
  'JSON',
] as const

export const FILTER_OPERATORS: Array<{ value: FilterOperator; label: string; unary?: boolean; multiple?: boolean }> = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'starts_with', label: '开头是' },
  { value: 'ends_with', label: '结尾是' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'between', label: '介于', multiple: true },
  { value: 'in', label: '属于', multiple: true },
  { value: 'not_in', label: '不属于', multiple: true },
  { value: 'is_null', label: '为空', unary: true },
  { value: 'is_not_null', label: '不为空', unary: true },
]

export function hasPermission(permissions: string[] | undefined, permission: string): boolean {
  return permissions === undefined || permissions.includes('*') || permissions.includes(permission)
}

export function encodePath(value: string): string {
  return encodeURIComponent(value)
}

export function createIdempotencyKey(prefix: string): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${id}`
}

export type StableOperation = {
  key: string
  snapshot: string
}

const operationKeys = new Map<string, string>()

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item instanceof Date) return item
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    )
  })
  return encoded ?? String(value)
}

function snapshotHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`
}

function operationStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Reuses one key for an identical pending write without storing its payload. */
export function stableOperation(scope: string, body: unknown): StableOperation {
  const snapshot = `rightdata:idempotency:v1:${scope}:${snapshotHash(stableJson(body))}`
  const storage = operationStorage()
  const existing = operationKeys.get(snapshot) ?? storage?.getItem(snapshot)
  if (existing) {
    operationKeys.set(snapshot, existing)
    return { key: existing, snapshot }
  }
  const key = createIdempotencyKey(scope)
  operationKeys.set(snapshot, key)
  try {
    storage?.setItem(snapshot, key)
  } catch {
    // Memory storage still protects retries for the current session.
  }
  return { key, snapshot }
}

/** Clears a pending key only after the server has confirmed the write. */
export function settleOperation(operation: StableOperation): void {
  operationKeys.delete(operation.snapshot)
  try {
    operationStorage()?.removeItem(operation.snapshot)
  } catch {
    // The in-memory entry has already been cleared.
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; code?: unknown }
    if (typeof value.message === 'string') return value.message
    if (typeof value.code === 'string') return value.code
  }
  return '操作失败，请稍后重试'
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function parseEditorValue(value: unknown, field: DataField): unknown {
  if (value === '' && field.nullable) return null
  const type = field.dataType.toUpperCase()
  if (type === 'BOOLEAN') {
    if (value === true || value === 'true' || value === '1') return true
    if (value === false || value === 'false' || value === '0') return false
  }
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|REAL|FLOAT|DOUBLE)$/.test(type)) {
    const numeric = Number(value)
    return Number.isNaN(numeric) ? value : numeric
  }
  return value
}

export function stableRowFilter(row: Record<string, unknown>, fields: DataField[]): DataFilter | undefined {
  const keys = fields.filter((field) => field.primaryKey)
  const fallback = fields.filter((field) => field.unique)
  const selected = keys.length ? keys : fallback.slice(0, 1)
  if (!selected.length || selected.some((field) => row[field.name] === undefined)) return undefined
  if (selected.length === 1) {
    return { field: selected[0].name, op: 'eq', value: row[selected[0].name] }
  }
  return {
    logic: 'and',
    rules: selected.map((field) => ({ field: field.name, op: 'eq', value: row[field.name] })),
  }
}

export function coerceFilterValue(raw: string, field?: DataField): unknown {
  if (!field) return raw
  const type = field.dataType.toUpperCase()
  if (type === 'BOOLEAN') return raw === 'true' || raw === '1'
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|REAL|FLOAT|DOUBLE)$/.test(type)) {
    const value = Number(raw)
    return Number.isNaN(value) ? raw : value
  }
  return raw
}

export function inferColumnType(values: unknown[]): string {
  const nonEmpty = values.filter((value) => value !== null && value !== undefined && value !== '')
  if (!nonEmpty.length) return 'VARCHAR'
  if (nonEmpty.every((value) => typeof value === 'boolean' || /^(true|false)$/i.test(String(value)))) return 'BOOLEAN'
  if (nonEmpty.every((value) => Number.isInteger(typeof value === 'number' ? value : Number(value)))) return 'BIGINT'
  if (nonEmpty.every((value) => !Number.isNaN(Number(value)))) return 'DOUBLE'
  if (nonEmpty.every((value) => value instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(String(value)))) return 'DATE'
  if (nonEmpty.every((value) => value instanceof Date || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(value)))) return 'TIMESTAMP'
  return 'VARCHAR'
}

export function normalizeParsedRows(name: string, sheetName: string, matrix: unknown[][]): ParsedDataFile {
  if (!matrix.length) throw new Error('文件中没有可导入的数据')
  const rawHeaders = matrix[0]
  if (!rawHeaders?.length) throw new Error('文件缺少表头')
  const headers = rawHeaders.map((value) => String(value ?? '').trim())
  if (headers.some((header) => !header)) throw new Error('表头不能为空')
  const keys = headers.map((header) => header.toLocaleLowerCase())
  if (new Set(keys).size !== keys.length) throw new Error('表头不能重复')
  const rows = matrix.slice(1).filter((row) => row.some((value) => value !== null && value !== undefined && value !== ''))
    .map((row) => headers.map((_header, index) => row[index] ?? null))
  if (!rows.length) throw new Error('文件只有表头，没有数据行')
  const inferredTypes = headers.map((_header, index) => inferColumnType(rows.slice(0, 200).map((row) => row[index])))
  return { name, sheetName, headers, rows, inferredTypes }
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N'
  let text: string
  if (value instanceof Date) text = value.toISOString()
  else if (typeof value === 'object') text = JSON.stringify(value)
  else text = String(value)
  return text === '\\N' || /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function createImportCsv(parsed: ParsedDataFile, mappings: ImportMapping[]): File {
  const selected = mappings.filter((mapping) => mapping.included)
  if (!selected.length) throw new Error('至少需要映射一个字段')
  if (selected.some((mapping) => !mapping.target.trim())) throw new Error('映射后的字段名不能为空')
  const targets = selected.map((mapping) => mapping.target.trim())
  if (new Set(targets.map((target) => target.toLocaleLowerCase())).size !== targets.length) {
    throw new Error('映射后的字段名不能重复')
  }
  const sourceIndexes = selected.map((mapping) => parsed.headers.indexOf(mapping.source))
  const lines = [targets.map(csvValue).join(',')]
  for (const row of parsed.rows) {
    lines.push(sourceIndexes.map((index) => csvValue(row[index])).join(','))
  }
  const baseName = parsed.name.replace(/\.[^.]+$/, '') || 'import'
  return new File([lines.join('\n')], `${baseName}.csv`, { type: 'application/vnd.rightdata.import+csv' })
}

export function parseJobProgress(progress: unknown): { phase: string; percent?: number } {
  if (typeof progress === 'string') {
    try {
      return parseJobProgress(JSON.parse(progress) as unknown)
    } catch {
      return { phase: progress }
    }
  }
  if (progress && typeof progress === 'object') {
    const value = progress as { phase?: unknown; percent?: unknown }
    return {
      phase: typeof value.phase === 'string' ? value.phase : 'running',
      percent: typeof value.percent === 'number' ? value.percent : undefined,
    }
  }
  return { phase: 'queued' }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / (1024 ** index)
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}
