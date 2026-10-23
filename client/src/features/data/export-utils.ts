import * as XLSX from 'xlsx/dist/xlsx.full.min.js'
import type { DataField } from './types'

const EXCEL_MAX_DATA_ROWS = 1_048_575

type ExportSchema = { type: 'schema'; fields: DataField[] }
type ExportChunk = { type: 'chunk'; rows: unknown[][] }
type ExportComplete = { type: 'complete'; complete: boolean; totalRows: string | number; sha256: string }

export type ExportWorkbook = {
  bytes: Uint8Array
  fields: DataField[]
  rowCount: number
  sheetCount: number
}

export type ExportWorkbookOptions = {
  maxRowsPerSheet?: number
}

function losslessJson(line: string): unknown {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < line.length;) {
    const character = line[index]
    if (inString) {
      output += character
      index += 1
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      output += character
      index += 1
      continue
    }
    const numeric = line.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (numeric) {
      output += `"${numeric[0]}"`
      index += numeric[0].length
      continue
    }
    output += character
    index += 1
  }
  return JSON.parse(output) as unknown
}

function numericType(dataType: string): 'exact' | 'safe-integer' | 'float' | null {
  const type = dataType.toUpperCase()
  if (type.includes('BIGINT') || type.includes('HUGEINT') || type.startsWith('DECIMAL')) return 'exact'
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER)$/.test(type)) return 'safe-integer'
  if (/^(REAL|FLOAT|DOUBLE)$/.test(type)) return 'float'
  return null
}

function excelCell(value: unknown, field: DataField): unknown {
  if (value === null || value === undefined) return null
  const kind = numericType(field.dataType)
  if (kind === 'exact') return String(value)
  if (kind === 'safe-integer' && typeof value === 'string') {
    const numeric = Number(value)
    return Number.isSafeInteger(numeric) ? numeric : value
  }
  if (kind === 'float' && typeof value === 'string') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : value
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function safeSheetBase(value: string): string {
  const sanitized = value.replace(/[\\/*?:[\]]/g, '_').trim()
  return sanitized || '数据'
}

function sheetName(base: string, index: number): string {
  const suffix = index === 1 ? '' : `_${index}`
  return `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`
}

function appendSheet(workbook: XLSX.WorkBook, baseName: string, index: number, fields: DataField[], rows: unknown[][]): void {
  const matrix = [fields.map((field) => field.name), ...rows]
  const sheet = XLSX.utils.aoa_to_sheet(matrix)
  if (fields.length) {
    sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: Math.max(0, rows.length), c: fields.length - 1 }) }
    sheet['!cols'] = fields.map((field, column) => {
      let width = field.name.length + 2
      for (const row of rows.slice(0, 200)) width = Math.max(width, String(row[column] ?? '').length + 2)
      return { wch: Math.min(42, Math.max(10, width)) }
    })
  }
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName(baseName, index))
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', source)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

/** Converts the server's chunked NDJSON artifact to an Excel workbook. */
export async function exportNdjsonToXlsx(
  bytes: Uint8Array,
  tableName: string,
  options: ExportWorkbookOptions = {},
): Promise<ExportWorkbook> {
  if (!bytes.length) throw new Error('导出文件为空')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const lines: Array<{ start: number; end: number; text: string }> = []
  let start = 0
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 10) continue
    let end = index
    if (end > start && bytes[end - 1] === 13) end -= 1
    const text = decoder.decode(bytes.subarray(start, end))
    if (text.trim()) lines.push({ start, end: index, text })
    start = index + 1
  }
  if (lines.length < 2) throw new Error('导出文件结构不完整')

  const footerLine = lines[lines.length - 1]
  const footer = losslessJson(footerLine.text) as ExportComplete
  if (footer.type !== 'complete' || footer.complete !== true || !footer.sha256) throw new Error('导出文件缺少完成标记')
  const actualHash = await sha256(bytes.subarray(0, footerLine.start))
  if (actualHash.toLocaleLowerCase() !== footer.sha256.toLocaleLowerCase()) throw new Error('导出文件完整性校验失败')

  const schema = JSON.parse(lines[0].text) as ExportSchema
  if (schema.type !== 'schema' || !Array.isArray(schema.fields) || !schema.fields.length) throw new Error('导出文件缺少字段结构')
  const fields = schema.fields
  const maxRows = Math.min(EXCEL_MAX_DATA_ROWS, Math.max(1, options.maxRowsPerSheet ?? EXCEL_MAX_DATA_ROWS))
  const workbook = XLSX.utils.book_new()
  const baseName = safeSheetBase(tableName)
  let pendingRows: unknown[][] = []
  let rowCount = 0
  let sheetCount = 0

  const flush = () => {
    if (!pendingRows.length && sheetCount > 0) return
    sheetCount += 1
    appendSheet(workbook, baseName, sheetCount, fields, pendingRows)
    pendingRows = []
  }

  for (const line of lines.slice(1, -1)) {
    const chunk = losslessJson(line.text) as ExportChunk
    if (chunk.type !== 'chunk' || !Array.isArray(chunk.rows)) throw new Error('导出文件包含无效数据块')
    for (const source of chunk.rows) {
      if (!Array.isArray(source) || source.length !== fields.length) throw new Error('导出数据与字段结构不一致')
      pendingRows.push(source.map((value, index) => excelCell(value, fields[index])))
      rowCount += 1
      if (pendingRows.length === maxRows) flush()
    }
  }
  if (pendingRows.length || sheetCount === 0) flush()

  let expectedRows: bigint
  try {
    expectedRows = BigInt(footer.totalRows)
  } catch {
    throw new Error('导出文件行数无效')
  }
  if (expectedRows !== BigInt(rowCount)) throw new Error('导出文件行数校验失败')

  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true }) as ArrayBuffer
  return { bytes: new Uint8Array(output), fields, rowCount, sheetCount }
}
