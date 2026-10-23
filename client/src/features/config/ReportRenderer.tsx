import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, message, Modal, Popconfirm, Space, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { saveLocalFile } from '../../lib/api'
import { settleOperation, stableOperation } from '../data/data-utils'
import { formatError } from './core'
import { reportCsvBytes, reportExportAvailability, reportExportColumns, reportExportFileName, reportXlsxBytes } from './report-export'
import { ImageExportButtons, captureElement, compareCellValues, parameterDefaults, ResourceParameterBar, type RendererProps } from './resource-ui'
import type { QueryResult, ReportBody, ReportColumn, ReportDrilldown } from './types'

type ExtendedQueryResult = QueryResult & { truncated?: boolean }
type MutationAction = 'insert' | 'update'
type MutationResult = { inserted: number; updated: number; deleted: number }
type EditState = { action: MutationAction; row?: Record<string, unknown>; values: Record<string, unknown> }
type DecimalValue = { coefficient: bigint; scale: number }

function ReportExportButtons({ name, result, configuredColumns }: { name: string; result?: QueryResult; configuredColumns?: ReportColumn[] }) {
  const [exporting, setExporting] = useState<'csv' | 'xlsx'>()
  const availability = reportExportAvailability(result)
  const save = async (format: 'csv' | 'xlsx') => {
    if (!result || !availability.available) return
    setExporting(format)
    try {
      const columns = reportExportColumns(result, configuredColumns)
      const bytes = format === 'csv' ? reportCsvBytes(result, columns) : reportXlsxBytes(result, columns, name)
      await saveLocalFile(reportExportFileName(name, format), bytes)
      message.success('报表数据已保存')
    } catch (cause) {
      message.error(formatError(cause, '报表数据导出失败'))
    } finally {
      setExporting(undefined)
    }
  }
  return <>
    <Button size="small" loading={exporting === 'csv'} disabled={!availability.available || (!!exporting && exporting !== 'csv')} onClick={() => void save('csv')}>导出已加载 CSV</Button>
    <Button size="small" loading={exporting === 'xlsx'} disabled={!availability.available || (!!exporting && exporting !== 'xlsx')} onClick={() => void save('xlsx')}>导出已加载 XLSX</Button>
  </>
}

function mappedQueryParams(params: Record<string, unknown>, bindings: ReportBody['parameterBindings']): Record<string, unknown> {
  const next = { ...params }
  for (const binding of bindings ?? []) {
    const source = binding.parameterKey.trim()
    const target = binding.queryParameterKey.trim()
    if (!source || !target || !(source in params)) continue
    next[target] = params[source]
    if (target !== source) delete next[source]
  }
  return next
}

function decimalValue(value: unknown): DecimalValue | undefined {
  let text: string
  if (typeof value === 'string') text = value.trim()
  else if (typeof value === 'number' && Number.isFinite(value)) text = value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 21 })
  else return undefined
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return undefined
  const fraction = match[3] ?? ''
  const coefficient = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`)
  return { coefficient, scale: fraction.length }
}

function pow10(power: number): bigint {
  return 10n ** BigInt(Math.max(0, power))
}

function roundedScale(value: DecimalValue, scale: number): DecimalValue {
  if (value.scale <= scale) return { coefficient: value.coefficient * pow10(scale - value.scale), scale }
  const divisor = pow10(value.scale - scale)
  let coefficient = value.coefficient / divisor
  const remainder = value.coefficient % divisor
  if ((remainder < 0n ? -remainder : remainder) * 2n >= divisor) coefficient += value.coefficient < 0n ? -1n : 1n
  return { coefficient, scale }
}

function decimalText(value: DecimalValue, decimals: number, percent = false): string {
  const scaled = roundedScale(percent ? { coefficient: value.coefficient * 100n, scale: value.scale } : value, decimals)
  const negative = scaled.coefficient < 0n
  const digits = (negative ? -scaled.coefficient : scaled.coefficient).toString().padStart(decimals + 1, '0')
  const integer = (decimals ? digits.slice(0, -decimals) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = decimals ? `.${digits.slice(-decimals)}` : ''
  return `${negative ? '-' : ''}${integer}${fraction}`
}

function compareReportCells(left: unknown, right: unknown, column: ReportColumn, order?: 'ascend' | 'descend' | null): number {
  const leftEmpty = left === null || left === undefined || left === ''
  const rightEmpty = right === null || right === undefined || right === ''
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0
    const emptyLastBeforeDirection = order === 'descend' ? -1 : 1
    return leftEmpty ? emptyLastBeforeDirection : -emptyLastBeforeDirection
  }
  if (column.format === 'number' || column.format === 'percent') {
    const leftDecimal = decimalValue(left)
    const rightDecimal = decimalValue(right)
    if (leftDecimal && rightDecimal) {
      const scale = Math.max(leftDecimal.scale, rightDecimal.scale)
      const leftCoefficient = leftDecimal.coefficient * pow10(scale - leftDecimal.scale)
      const rightCoefficient = rightDecimal.coefficient * pow10(scale - rightDecimal.scale)
      return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0
    }
  }
  return compareCellValues(left, right)
}

function formattedCell(value: unknown, column: ReportColumn): string {
  if (value === null || value === undefined || value === '') return '--'
  if (column.format === 'number' || column.format === 'percent') {
    const exact = decimalValue(value)
    if (exact) {
      const decimals = Math.max(0, Math.min(12, column.decimals ?? (column.format === 'percent' ? 2 : 0)))
      return `${decimalText(exact, decimals, column.format === 'percent')}${column.format === 'percent' ? '%' : (column.unit ?? '')}`
    }
  }
  if ((column.format === 'date' || column.format === 'datetime') && typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return `${column.format === 'date' ? date.toLocaleDateString('zh-CN') : date.toLocaleString('zh-CN')}${column.unit ?? ''}`
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return `${text}${column.unit ?? ''}`
}

function summaryValue(rows: Array<Record<string, unknown>>, column: ReportColumn): string {
  if (!column.summary) return ''
  if (column.summary === 'count') return String(rows.filter((row) => row[column.key] !== null && row[column.key] !== undefined).length)
  const values = rows.map((row) => row[column.key]).filter((value) => value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')).map(decimalValue).filter((value): value is DecimalValue => !!value)
  if (!values.length) return '--'
  const scale = Math.max(...values.map((value) => value.scale))
  const aligned = values.map((value) => value.coefficient * pow10(scale - value.scale))
  let coefficient: bigint
  let resultScale = scale
  if (column.summary === 'sum' || column.summary === 'avg') coefficient = aligned.reduce((total, value) => total + value, 0n)
  else coefficient = aligned.reduce((selected, value) => column.summary === 'min' ? (value < selected ? value : selected) : (value > selected ? value : selected))
  if (column.summary === 'avg') {
    const extraScale = 12
    const divisor = BigInt(aligned.length)
    const numerator = coefficient * pow10(extraScale)
    let quotient = numerator / divisor
    const remainder = numerator % divisor
    if ((remainder < 0n ? -remainder : remainder) * 2n >= divisor) quotient += numerator < 0n ? -1n : 1n
    coefficient = quotient
    resultScale += extraScale
  }
  const decimals = Math.max(0, Math.min(12, column.decimals ?? (column.format === 'percent' ? 2 : 0)))
  return `${decimalText({ coefficient, scale: resultScale }, decimals, column.format === 'percent')}${column.format === 'percent' ? '%' : (column.unit ?? '')}`
}

function summaryLabel(summary: NonNullable<ReportColumn['summary']>): string {
  return ({ sum: '合计', avg: '平均', min: '最小', max: '最大', count: '计数' })[summary]
}

function rowFilter(row: Record<string, unknown>, keyFields: string[]) {
  if (!keyFields.length || keyFields.some((field) => row[field] === undefined)) return undefined
  return { logic: 'and' as const, rules: keyFields.map((field) => ({ field, op: 'eq', value: row[field] })) }
}

function editorValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function parseWriteValue(raw: unknown, dataType?: string): unknown {
  if (typeof raw !== 'string') return raw
  const type = (dataType ?? '').toUpperCase()
  if (type === 'BOOLEAN') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
  }
  // BIGINT and DECIMAL remain strings so JavaScript cannot round them.
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|REAL|FLOAT|DOUBLE)$/.test(type)) {
    const value = Number(raw)
    return Number.isNaN(value) ? raw : value
  }
  return raw
}

export function ReportRenderer({ resource, body, params, onParamsChange, execute, api, permissions, preview, onDrill }: RendererProps & { body: ReportBody }) {
  const [result, setResult] = useState<ExtendedQueryResult>()
  const [error, setError] = useState('')
  const [querying, setQuerying] = useState(false)
  const [edit, setEdit] = useState<EditState>()
  const [mutating, setMutating] = useState(false)
  const initialQuery = useRef(false)
  const querySequence = useRef(0)
  const paramsKey = JSON.stringify(params)
  const previousParamsKey = useRef(paramsKey)
  const exportSurface = useRef<HTMLDivElement>(null)
  const definitionId = body.primaryDefinitionId || body.definitionIds?.[0] || ''
  const bindingsKey = JSON.stringify(body.parameterBindings ?? [])
  const sourceKey = `${definitionId}\u0000${bindingsKey}`
  const previousSourceKey = useRef(sourceKey)
  const maintenance = body.maintenance
  const canWrite = !preview && !!api && !!maintenance && maintenance.definitionId === definitionId
    && maintenance.keyFields.length > 0 && (permissions?.includes('*') || permissions?.includes('data.write'))

  const query = useCallback(async () => {
    if (!definitionId) return
    const sequence = ++querySequence.current
    setQuerying(true); setError('')
    try {
      const next = await execute(definitionId, mappedQueryParams(params, body.parameterBindings))
      if (sequence === querySequence.current) setResult(next)
    } catch (cause) {
      if (sequence === querySequence.current) setError(formatError(cause, '查询失败'))
    } finally {
      if (sequence === querySequence.current) setQuerying(false)
    }
  }, [bindingsKey, definitionId, execute, params])

  useEffect(() => {
    if (previousSourceKey.current === sourceKey) return
    previousSourceKey.current = sourceKey
    initialQuery.current = false
    querySequence.current += 1; setResult(undefined); setError(''); setQuerying(false)
  }, [sourceKey])

  useEffect(() => {
    if (previousParamsKey.current === paramsKey) return
    previousParamsKey.current = paramsKey
    querySequence.current += 1; setResult(undefined); setError(''); setQuerying(false)
  }, [paramsKey])
  useEffect(() => {
    const parameters = body.parameters ?? []
    if (parameters.length && Object.keys(params).length === 0) { onParamsChange(parameterDefaults(parameters)); return }
    if (!definitionId || initialQuery.current) return
    initialQuery.current = true
    void query()
  }, [body.parameters, definitionId, onParamsChange, params, query])

  const visibleColumns = useMemo<ReportColumn[]>(() => {
    if (!result) return []
    const configured = (body.columns ?? []).filter((column) => column.key)
    return configured.length ? configured.filter((column) => column.visible !== false) : result.fields.map((field) => ({ key: field.name, title: field.name }))
  }, [body.columns, result])
  const sorts = body.defaultSorts ?? []
  const drilldowns = body.drilldowns ?? []
  const updateFields = maintenance?.writableFields.filter((field) => !maintenance.keyFields.includes(field)) ?? []

  const columns = useMemo<ColumnsType<Record<string, unknown>>>(() => {
    const next: ColumnsType<Record<string, unknown>> = visibleColumns.map((column) => {
      const sortIndex = sorts.findIndex((sort) => sort.key === column.key)
      const drilldown: ReportDrilldown | undefined = drilldowns.find((item) => item.triggerField === column.key && item.targetResourceId)
      return {
        title: column.title || column.key,
        dataIndex: column.key,
        key: column.key,
        width: column.width,
        align: column.align,
        ellipsis: true,
        sorter: { compare: (left, right, order) => compareReportCells(left[column.key], right[column.key], column, order), multiple: sortIndex < 0 ? 1 : sorts.length - sortIndex + 1 },
        defaultSortOrder: sortIndex < 0 ? undefined : sorts[sortIndex].direction,
        render: (value: unknown, row) => {
          const display = formattedCell(value, column)
          if (!drilldown || !onDrill) return display
          const targetParams = Object.fromEntries(drilldown.parameterMappings.filter((mapping) => mapping.targetParameter).map((mapping) => [mapping.targetParameter, row[mapping.sourceField]]))
          return <Button type="link" size="small" onClick={() => onDrill(drilldown.targetResourceId, targetParams)}>{display}</Button>
        },
      }
    })
    if (canWrite && ((maintenance?.allowUpdate && updateFields.length > 0) || maintenance?.allowDelete)) next.push({
      title: '操作', key: '__actions', fixed: 'right', width: 128,
      render: (_value, row) => <Space size={0}>
        {maintenance.allowUpdate && updateFields.length > 0 ? <Button type="link" size="small" disabled={!rowFilter(row, maintenance.keyFields)} onClick={() => setEdit({ action: 'update', row, values: Object.fromEntries(updateFields.map((field) => [field, row[field]])) })}>编辑</Button> : null}
        {maintenance.allowDelete ? <Popconfirm title="删除这条记录？" okText="删除" cancelText="取消" onConfirm={() => void mutate('delete', row)}><Button danger type="link" size="small" disabled={!rowFilter(row, maintenance.keyFields)}>删除</Button></Popconfirm> : null}
      </Space>,
    })
    return next
  // mutate is a function declaration and reads the dependencies listed here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleColumns, sorts, drilldowns, onDrill, canWrite, maintenance, updateFields, result, edit, mutating])

  async function mutate(action: MutationAction | 'delete', row?: Record<string, unknown>) {
    if (!api || !maintenance || !canWrite || mutating) return
    const filter = row ? rowFilter(row, maintenance.keyFields) : undefined
    if (action !== 'insert' && !filter) { message.error('缺少完整主键，无法安全写入'); return }
    const fieldTypes = new Map((result?.fields ?? []).map((field) => [field.name, (field as { dataType?: string; type?: string }).dataType ?? field.type]))
    const writeFields = action === 'update' ? maintenance.writableFields.filter((field) => !maintenance.keyFields.includes(field)) : maintenance.writableFields
    const values = action === 'delete' ? undefined : Object.fromEntries(writeFields
      .filter((field) => edit?.values[field] !== undefined)
      .map((field) => [field, parseWriteValue(edit?.values[field], fieldTypes.get(field))]))
    if (action !== 'delete' && Object.keys(values ?? {}).length === 0) { message.error('没有可写字段'); return }
    const operation = { action, values, filter }
    const bodyValue = { operations: [operation] }
    const stable = stableOperation(`report-${action}`, { datasetId: maintenance.datasetId, table: maintenance.table, body: bodyValue })
    setMutating(true)
    try {
      const response = await api.request<MutationResult>(`/api/v1/datasets/${encodeURIComponent(maintenance.datasetId)}/tables/${encodeURIComponent(maintenance.table)}/records:mutate`, {
        method: 'POST', body: bodyValue, idempotencyKey: stable.key,
      })
      settleOperation(stable)
      setEdit(undefined)
      const count = action === 'insert' ? response.inserted : action === 'update' ? response.updated : response.deleted
      message.success(`${action === 'insert' ? '新增' : action === 'update' ? '更新' : '删除'} ${count} 条记录`)
      await query()
    } catch (cause) {
      message.error(formatError(cause, '写入失败'))
    } finally {
      setMutating(false)
    }
  }

  const exportAvailability = reportExportAvailability(result)
  const fullResult = !!result && result.truncated !== true && result.rows.length === result.total
  const hasSummaries = visibleColumns.some((column) => column.summary)
  return <div className="rd-config-runtime">
    <ResourceParameterBar parameters={body.parameters ?? []} value={params} onChange={onParamsChange} onSubmit={() => void query()} loading={querying} />
    {error ? <Alert type="error" showIcon message={error} /> : null}
    {result && exportAvailability.message ? <Alert type="warning" showIcon message={exportAvailability.message} /> : null}
    <div className="rd-config-export-actions">
      <ReportExportButtons name={resource.name} result={result} configuredColumns={body.columns} />
      <ImageExportButtons name={resource.name} capture={(format) => captureElement(exportSurface.current, format, '#ffffff')} />
      {canWrite && maintenance?.allowInsert ? <Button size="small" onClick={() => setEdit({ action: 'insert', values: {} })}>新增记录</Button> : null}
    </div>
    <div ref={exportSurface} className="rd-config-data-surface">
      {!result ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="执行查询后显示数据" /> : <Table
        size="small" rowKey={(_, index) => String(index)} columns={columns} dataSource={result.rows}
        pagination={{ pageSize: Math.max(1, body.pageSize ?? 20), showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} scroll={{ x: 'max-content' }}
        summary={(currentRows) => <>
          {hasSummaries ? <Table.Summary.Row>{visibleColumns.map((column, index) => <Table.Summary.Cell key={column.key} index={index}>{column.summary ? `${fullResult ? '全量' : '已加载'}${summaryLabel(column.summary)}：${summaryValue(result.rows, column)}` : ''}</Table.Summary.Cell>)}{columns.length > visibleColumns.length ? <Table.Summary.Cell index={visibleColumns.length} /> : null}</Table.Summary.Row> : null}
          <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={columns.length}>当前页 {currentRows.length} 条 · 已加载 {result.rows.length} 条 · 查询总数 {result.total} 条{fullResult ? ' · 全量结果' : ''}</Table.Summary.Cell></Table.Summary.Row>
        </>}
      />}
    </div>
    <Modal open={!!edit} title={edit?.action === 'insert' ? '新增记录' : '编辑记录'} okText="保存" cancelText="取消" confirmLoading={mutating} onCancel={() => !mutating && setEdit(undefined)} onOk={() => void mutate(edit?.action ?? 'update', edit?.row)}>
      <div className="rd-config-form-grid">
        {(maintenance?.writableFields ?? []).filter((field) => edit?.action === 'insert' || !maintenance?.keyFields.includes(field)).map((field) => {
          const label = body.columns?.find((column) => column.key === field)?.title || field
          return <label className="rd-config-field" key={field}><span>{label}</span><Input value={editorValue(edit?.values[field])} onChange={(event) => setEdit((current) => current ? { ...current, values: { ...current.values, [field]: event.target.value } } : current)} /></label>
        })}
      </div>
    </Modal>
  </div>
}
