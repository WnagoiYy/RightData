import * as XLSX from 'xlsx/dist/xlsx.full.min.js'
import type { QueryResult, ReportColumn } from './types'

export type ReportExportColumn = Pick<ReportColumn, 'key' | 'title'>
type ExportableQueryResult = QueryResult & { truncated?: boolean }

export type ReportExportAvailability = {
  available: boolean
  message?: string
}

export function reportExportColumns(result: QueryResult, configuredColumns?: ReportColumn[]): ReportExportColumn[] {
  const configured = (configuredColumns ?? []).filter((column) => column.key)
  if (configured.length) {
    const visible = configured.filter((column) => column.visible !== false)
    if (!visible.length) throw new Error('报表没有可导出的显示列')
    const available = new Set(result.fields.map((field) => field.name))
    const missing = visible.filter((column) => !available.has(column.key)).map((column) => column.key)
    if (missing.length) throw new Error(`查询结果缺少报表字段：${missing.join('、')}`)
    return visible.map(({ key, title }) => ({ key, title: title || key }))
  }
  return result.fields.map((field) => ({ key: field.name, title: field.name }))
}

export function reportExportAvailability(result?: ExportableQueryResult): ReportExportAvailability {
  if (!result) return { available: false }
  const loaded = result.rows.length
  const total = result.total
  if (!Number.isSafeInteger(total) || total < 0 || total < loaded) {
    return { available: false, message: `查询总数无法核验；已加载 ${loaded} 条。本地数据导出已停用，请到数据工作台执行全量导出。` }
  }
  if (result.truncated === true || loaded !== total) {
    return { available: false, message: `当前结果仅加载 ${loaded}/${total} 条。本地数据导出已停用，请到数据工作台执行全量导出。` }
  }
  return { available: true }
}

function exportCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}

function csvCell(value: unknown): string {
  const text = String(exportCell(value) ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function reportCsvBytes(result: QueryResult, columns: ReportExportColumn[]): Uint8Array {
  const lines = [
    columns.map((column) => csvCell(column.title || column.key)).join(','),
    ...result.rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(',')),
  ]
  return new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}\r\n`)
}

export function reportXlsxBytes(result: QueryResult, columns: ReportExportColumn[], sheetTitle: string): Uint8Array {
  const rows = [
    columns.map((column) => column.title || column.key),
    ...result.rows.map((row) => columns.map((column) => exportCell(row[column.key]))),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  if (columns.length) {
    sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: Math.max(0, result.rows.length), c: columns.length - 1 }) }
    sheet['!cols'] = columns.map((column) => {
      let width = (column.title || column.key).length + 2
      for (const row of result.rows.slice(0, 200)) width = Math.max(width, String(exportCell(row[column.key]) ?? '').length + 2)
      return { wch: Math.min(42, Math.max(10, width)) }
    })
  }
  const workbook = XLSX.utils.book_new()
  const safeTitle = sheetTitle.replace(/[\\/*?:[\]]/g, '_').trim().slice(0, 31) || '报表'
  XLSX.utils.book_append_sheet(workbook, sheet, safeTitle)
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true }) as ArrayBuffer
  return new Uint8Array(output)
}

export function reportExportFileName(name: string, extension: 'csv' | 'xlsx'): string {
  const safeName = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'rightdata'
  return `${safeName}.${extension}`
}
