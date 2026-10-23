import {
  App,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiOutlined,
  BarsOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FieldBinaryOutlined,
  FilterOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  TableOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DATA_TYPES,
  FILTER_OPERATORS,
  coerceFilterValue,
  createIdempotencyKey,
  encodePath,
  errorMessage,
  formatCell,
  hasPermission,
  parseJobProgress,
  parseEditorValue,
  settleOperation,
  stableOperation,
  stableRowFilter,
} from './data-utils'
import type {
  DataFeatureProps,
  DataField,
  DataFilter,
  DataJob,
  DatasetSummary,
  FieldDefinition,
  FilterOperator,
  MutationResult,
  QueryResult,
  JobState,
} from './types'
import { exportNdjsonToXlsx } from './export-utils'
import { JobRecoveryControls, useRecoverableJob } from './job-recovery'
import './data-workspace.css'

type QueryMode = 'structured' | 'sql'

type FilterDraft = {
  id: string
  field: string
  operator: FilterOperator
  value: string
}

type SchemaAction =
  | { kind: 'add' }
  | { kind: 'rename'; field: DataField }
  | { kind: 'alter'; field: DataField }
  | null

type DraftField = FieldDefinition & { key: string }

const typeOptions = DATA_TYPES.map((value) => ({ value, label: value }))
const terminalJobStates = new Set<JobState>(['succeeded', 'failed', 'canceled', 'expired'])

function makeDraftField(index = 0): DraftField {
  return {
    key: `${Date.now()}-${Math.random()}-${index}`,
    name: index === 0 ? 'id' : '',
    dataType: index === 0 ? 'BIGINT' : 'VARCHAR',
    nullable: index !== 0,
    primaryKey: index === 0,
    unique: false,
  }
}

function filterFromDraft(draft: FilterDraft, fields: DataField[]): DataFilter | null {
  if (!draft.field) return null
  const operator = FILTER_OPERATORS.find((item) => item.value === draft.operator)
  if (operator?.unary) return { field: draft.field, op: draft.operator }
  const field = fields.find((item) => item.name === draft.field)
  if (operator?.multiple) {
    const values = draft.value.split(',').map((value) => value.trim()).filter(Boolean)
      .map((value) => coerceFilterValue(value, field))
    if (!values.length) return null
    return { field: draft.field, op: draft.operator, values }
  }
  if (draft.value === '') return null
  return { field: draft.field, op: draft.operator, value: coerceFilterValue(draft.value, field) }
}

function RecordFields({ fields }: { fields: DataField[] }) {
  return <>
    {fields.map((field) => (
      <Form.Item
        key={field.name}
        name={field.name}
        label={<span>{field.name} <small>{field.dataType}</small></span>}
        rules={[{ required: !field.nullable && field.default === undefined, message: `请输入 ${field.name}` }]}
      >
        {field.dataType === 'BOOLEAN'
          ? <Select allowClear options={[{ value: true, label: 'true' }, { value: false, label: 'false' }]} />
          : <Input allowClear placeholder={field.nullable ? '留空写入 NULL' : undefined} />}
      </Form.Item>
    ))}
  </>
}

function exportResultLabel(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try {
      return exportResultLabel(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const name = (value as { name?: unknown }).name
  if (typeof name !== 'string' || !name.trim()) return undefined
  return name.replace(/\.ndjson$/i, '')
}

export function DataWorkspace({ api, permissions, taskScope }: DataFeatureProps) {
  const { message } = App.useApp()
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [tables, setTables] = useState<string[]>([])
  const [fields, setFields] = useState<DataField[]>([])
  const [datasetId, setDatasetId] = useState('')
  const [tableName, setTableName] = useState('')
  const [queryMode, setQueryMode] = useState<QueryMode>('structured')
  const [selectedFields, setSelectedFields] = useState<string[]>([])
  const [filterLogic, setFilterLogic] = useState<'and' | 'or'>('and')
  const [filters, setFilters] = useState<FilterDraft[]>([])
  const [orderField, setOrderField] = useState('')
  const [orderDirection, setOrderDirection] = useState<'ASC' | 'DESC'>('ASC')
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(false)
  const [metaLoading, setMetaLoading] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null)
  const [recordSaving, setRecordSaving] = useState(false)
  const [schemaOpen, setSchemaOpen] = useState(false)
  const [schemaAction, setSchemaAction] = useState<SchemaAction>(null)
  const [schemaSaving, setSchemaSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTableName, setCreateTableName] = useState('')
  const [draftFields, setDraftFields] = useState<DraftField[]>([makeDraftField()])
  const [exportFileBase, setExportFileBase] = useState('')
  const [exportSaving, setExportSaving] = useState<'excel' | 'ndjson' | null>(null)
  const [recordForm] = Form.useForm<Record<string, unknown>>()
  const [schemaForm] = Form.useForm<{ name: string; dataType: string; nullable: boolean; default?: string }>()

  const canRead = hasPermission(permissions, 'data.read')
  const canWrite = hasPermission(permissions, 'data.write')
  const canSchema = hasPermission(permissions, 'schema.manage')
  const canSQL = hasPermission(permissions, 'sql.execute')
  const canExport = hasPermission(permissions, 'data.export')
  const canReadJobs = hasPermission(permissions, 'jobs.read')
  const reportJobError = useCallback((value: string) => { message.error(value) }, [message])
  const resolveExportLabel = useCallback((job: DataJob) => exportResultLabel(job.result), [])
  const applyExportReference = useCallback((_job: DataJob, reference: { label: string }) => {
    setExportFileBase(reference.label)
  }, [])
  const {
    job: exportJob,
    references: exportJobReferences,
    activeId: activeExportJobId,
    activeReference: activeExportReference,
    recovering: recoveringExportJob,
    recover: refreshExportJob,
    rememberSubmitted: rememberSubmittedExport,
  } = useRecoverableJob({
    api,
    canReadJobs,
    kind: 'export',
    taskScope,
    fallbackLabel: '导出任务',
    onError: reportJobError,
    onRecovered: applyExportReference,
    resolveLabel: resolveExportLabel,
  })

  const tableBasePath = datasetId && tableName
    ? `/api/v1/datasets/${encodePath(datasetId)}/tables/${encodePath(tableName)}`
    : ''

  const loadDatasets = useCallback(async (signal?: AbortSignal) => {
    if (!canRead) return
    setMetaLoading(true)
    try {
      const response = await api.request<{ datasets: DatasetSummary[] }>('/api/v1/datasets', { signal })
      setDatasets(response.datasets ?? [])
      setDatasetId((current) => current || response.datasets?.[0]?.id || '')
    } catch (error) {
      if (!signal?.aborted) message.error(errorMessage(error))
    } finally {
      if (!signal?.aborted) setMetaLoading(false)
    }
  }, [api, canRead, message])

  const loadTables = useCallback(async (targetDataset: string, signal?: AbortSignal) => {
    if (!targetDataset) return
    setMetaLoading(true)
    try {
      const response = await api.request<{ tables: string[] }>(`/api/v1/datasets/${encodePath(targetDataset)}/tables`, { signal })
      setTables(response.tables ?? [])
      setTableName((current) => response.tables?.includes(current) ? current : response.tables?.[0] || '')
    } catch (error) {
      if (!signal?.aborted) message.error(errorMessage(error))
    } finally {
      if (!signal?.aborted) setMetaLoading(false)
    }
  }, [api, message])

  const loadSchema = useCallback(async (targetDataset: string, targetTable: string, signal?: AbortSignal) => {
    if (!targetDataset || !targetTable) return
    setMetaLoading(true)
    try {
      const response = await api.request<{ fields: DataField[] }>(
        `/api/v1/datasets/${encodePath(targetDataset)}/tables/${encodePath(targetTable)}/schema`,
        { signal },
      )
      setFields(response.fields ?? [])
      setSelectedFields((current) => current.filter((name) => response.fields.some((field) => field.name === name)))
      setOrderField((current) => response.fields.some((field) => field.name === current) ? current : '')
      setSql((current) => current || `SELECT * FROM "${targetTable.replace(/"/g, '""')}" LIMIT 100`)
    } catch (error) {
      if (!signal?.aborted) message.error(errorMessage(error))
    } finally {
      if (!signal?.aborted) setMetaLoading(false)
    }
  }, [api, message])

  useEffect(() => {
    const controller = new AbortController()
    void loadDatasets(controller.signal)
    return () => controller.abort()
  }, [loadDatasets])

  useEffect(() => {
    setTables([])
    setTableName('')
    setFields([])
    setResult(null)
    if (!datasetId) return
    const controller = new AbortController()
    void loadTables(datasetId, controller.signal)
    return () => controller.abort()
  }, [datasetId, loadTables])

  useEffect(() => {
    setFields([])
    setResult(null)
    setFilters([])
    setPage(1)
    if (!datasetId || !tableName) return
    const controller = new AbortController()
    void loadSchema(datasetId, tableName, controller.signal)
    return () => controller.abort()
  }, [datasetId, loadSchema, tableName])

  const buildStructuredFilters = useCallback((): DataFilter[] => {
    const rules = filters.map((filter) => filterFromDraft(filter, fields)).filter((filter): filter is DataFilter => Boolean(filter))
    if (rules.length <= 1) return rules
    return [{ logic: filterLogic, rules }]
  }, [fields, filterLogic, filters])

  const runStructuredQuery = useCallback(async (targetPage = page, targetPageSize = pageSize) => {
    if (!tableBasePath) return
    setLoading(true)
    try {
      const response = await api.request<QueryResult>(`${tableBasePath}/query`, {
        method: 'POST',
        body: {
          fields: selectedFields,
          filters: buildStructuredFilters(),
          orderBy: orderField ? [{ field: orderField, direction: orderDirection }] : [],
          limit: targetPageSize,
          offset: (targetPage - 1) * targetPageSize,
        },
      })
      setResult(response)
      setPage(targetPage)
      setPageSize(targetPageSize)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [api, buildStructuredFilters, message, orderDirection, orderField, page, pageSize, selectedFields, tableBasePath])

  const runSqlQuery = useCallback(async () => {
    if (!datasetId || !sql.trim()) return
    setLoading(true)
    try {
      const response = await api.request<QueryResult>(`/api/v1/datasets/${encodePath(datasetId)}/sql:query`, {
        method: 'POST',
        body: { sql },
      })
      setResult(response)
      setPage(1)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [api, datasetId, message, sql])

  const runQuery = useCallback(() => queryMode === 'structured' ? runStructuredQuery(1, pageSize) : runSqlQuery(), [pageSize, queryMode, runSqlQuery, runStructuredQuery])

  const submitExport = async () => {
    if (!datasetId || !tableName) return
    const body = {
      datasetId,
      table: tableName,
      fields: selectedFields.length ? selectedFields : fields.map((field) => field.name),
      filters: buildStructuredFilters(),
      orderBy: orderField ? [{ field: orderField, direction: orderDirection }] : [],
    }
    const operation = stableOperation('export-job', body)
    try {
      const created = await api.request<{ jobId: string; state: JobState }>('/api/v1/export-jobs', {
        method: 'POST',
        body,
        idempotencyKey: operation.key,
      })
      const submitted = {
        id: created.jobId,
        kind: 'export',
        datasetId,
        state: created.state,
        progress: { phase: created.state },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: '',
      } satisfies DataJob
      rememberSubmittedExport(submitted, tableName)
      settleOperation(operation)
      message.success('全量导出任务已提交')
      if (canReadJobs) await refreshExportJob(created.jobId)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const exportFileName = (extension: 'xlsx' | 'ndjson') => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    return `${exportFileBase || 'export'}-${stamp}.${extension}`
  }

  const recordExportOutcome = async (jobId: string, outcome: 'success' | 'failed' | 'canceled') => {
    if (!api.recordExportEvent) return
    try {
      await api.recordExportEvent(jobId, outcome)
    } catch {
      message.warning('导出结果记录失败，请稍后重试')
    }
  }

  const downloadExportNdjson = async () => {
    if (!exportJob || exportJob.state !== 'succeeded') return
    setExportSaving('ndjson')
    let outcome: 'success' | 'failed' | 'canceled' = 'success'
    try {
      await api.download(`/api/v1/jobs/${encodePath(exportJob.id)}/download`, exportFileName('ndjson'))
      message.success('NDJSON 已保存')
    } catch (error) {
      outcome = typeof error === 'object' && error && 'code' in error && error.code === 'canceled' ? 'canceled' : 'failed'
      message.error(errorMessage(error))
    } finally {
      await recordExportOutcome(exportJob.id, outcome)
      setExportSaving(null)
    }
  }

  const downloadExportExcel = async () => {
    if (!exportJob || exportJob.state !== 'succeeded') return
    setExportSaving('excel')
    let outcome: 'success' | 'failed' | 'canceled' = 'success'
    try {
      const path = `/api/v1/jobs/${encodePath(exportJob.id)}/download`
      const source = await api.readDownload(path, 64 * 1024 * 1024)
      const workbook = await exportNdjsonToXlsx(source, exportFileBase || '数据')
      await api.saveFile(exportFileName('xlsx'), workbook.bytes)
      message.success(`Excel 已保存，共 ${workbook.rowCount.toLocaleString()} 行`)
    } catch (error) {
      outcome = typeof error === 'object' && error && 'code' in error && error.code === 'canceled' ? 'canceled' : 'failed'
      message.error(errorMessage(error))
    } finally {
      await recordExportOutcome(exportJob.id, outcome)
      setExportSaving(null)
    }
  }

  const openRecord = (row?: Record<string, unknown>) => {
    setEditingRow(row ?? null)
    setRecordOpen(true)
    recordForm.resetFields()
    if (row) recordForm.setFieldsValue(row)
  }

  const saveRecord = async () => {
    if (!tableBasePath) return
    const values = await recordForm.validateFields()
    const payload = Object.fromEntries(fields.map((field) => [field.name, parseEditorValue(values[field.name], field)]))
    const filter = editingRow ? stableRowFilter(editingRow, fields) : undefined
    if (editingRow && !filter) {
      message.error('当前表没有可用于定位记录的主键或唯一字段')
      return
    }
    setRecordSaving(true)
    const body = { operations: [{ action: editingRow ? 'update' : 'insert', values: payload, filter }] }
    const operation = stableOperation('record', { path: tableBasePath, body })
    try {
      const response = await api.request<MutationResult>(`${tableBasePath}/records:mutate`, {
        method: 'POST',
        idempotencyKey: operation.key,
        body,
      })
      settleOperation(operation)
      message.success(editingRow ? `已更新 ${response.updated} 条记录` : `已新增 ${response.inserted} 条记录`)
      setRecordOpen(false)
      await runStructuredQuery(page, pageSize)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setRecordSaving(false)
    }
  }

  const deleteRecord = async (row: Record<string, unknown>) => {
    if (!tableBasePath) return
    const filter = stableRowFilter(row, fields)
    if (!filter) {
      message.error('当前表没有可用于定位记录的主键或唯一字段')
      return
    }
    const body = { operations: [{ action: 'delete', filter }] }
    const operation = stableOperation('record', { path: tableBasePath, body })
    try {
      const response = await api.request<MutationResult>(`${tableBasePath}/records:mutate`, {
        method: 'POST',
        idempotencyKey: operation.key,
        body,
      })
      settleOperation(operation)
      message.success(`已删除 ${response.deleted} 条记录`)
      await runStructuredQuery(page, pageSize)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const mutateSchema = async (body: Record<string, unknown>, successText: string) => {
    if (!datasetId) return
    setSchemaSaving(true)
    const operation = stableOperation('schema', { datasetId, body })
    try {
      await api.request(`/api/v1/datasets/${encodePath(datasetId)}/schema:mutate`, {
        method: 'POST',
        idempotencyKey: operation.key,
        body,
      })
      settleOperation(operation)
      message.success(successText)
      setSchemaAction(null)
      if (body.action === 'drop_table') {
        await loadTables(datasetId)
      } else if (tableName) {
        await loadSchema(datasetId, tableName)
      }
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSchemaSaving(false)
    }
  }

  const submitSchemaAction = async () => {
    if (!schemaAction || !tableName) return
    const value = await schemaForm.validateFields()
    if (schemaAction.kind === 'add') {
      await mutateSchema({
        action: 'add_column',
        table: tableName,
        field: { name: value.name, dataType: value.dataType, nullable: value.nullable, default: value.default || undefined },
      }, '字段已新增')
    } else if (schemaAction.kind === 'rename') {
      await mutateSchema({ action: 'rename_column', table: tableName, column: schemaAction.field.name, newName: value.name }, '字段已重命名')
    } else {
      await mutateSchema({ action: 'alter_type', table: tableName, column: schemaAction.field.name, newType: value.dataType }, '字段类型已更新')
    }
  }

  const createTable = async () => {
    const name = createTableName.trim()
    if (!name) {
      message.warning('请输入数据表名称')
      return
    }
    if (draftFields.some((field) => !field.name.trim())) {
      message.warning('字段名不能为空')
      return
    }
    const fieldNames = draftFields.map((field) => field.name.trim().toLocaleLowerCase())
    if (new Set(fieldNames).size !== fieldNames.length) {
      message.warning('字段名不能重复')
      return
    }
    await mutateSchema({
      action: 'create_table',
      table: name,
      fields: draftFields.map(({ key: _key, ...field }) => ({ ...field, name: field.name.trim() })),
    }, '数据表已创建')
    setCreateOpen(false)
    setCreateTableName('')
    setDraftFields([makeDraftField()])
    await loadTables(datasetId)
    setTableName(name)
  }

  const resultColumns = useMemo<ColumnsType<Record<string, unknown>>>(() => {
    if (!result) return []
    const dataColumns: ColumnsType<Record<string, unknown>> = result.fields.map((field) => ({
      title: <span className="rd-column-heading"><b>{field.name}</b><small>{field.dataType}</small></span>,
      dataIndex: field.name,
      key: field.name,
      width: Math.max(132, Math.min(280, field.name.length * 14 + 72)),
      ellipsis: { showTitle: false },
      render: (value: unknown) => <Tooltip title={formatCell(value)}><span className={value == null ? 'rd-null' : undefined}>{value == null ? 'NULL' : formatCell(value)}</span></Tooltip>,
    }))
    if (canWrite && queryMode === 'structured') {
      dataColumns.push({
        title: '操作',
        key: 'actions',
        fixed: 'right',
        width: 92,
        render: (_value, row) => <Space size={2}>
          <Tooltip title="编辑记录"><Button type="text" size="small" aria-label="编辑记录" icon={<EditOutlined />} disabled={!stableRowFilter(row, fields)} onClick={() => openRecord(row)} /></Tooltip>
          <Popconfirm title="删除这条记录？" okText="删除" cancelText="取消" onConfirm={() => void deleteRecord(row)}>
            <Tooltip title="删除记录"><Button danger type="text" size="small" aria-label="删除记录" icon={<DeleteOutlined />} disabled={!stableRowFilter(row, fields)} /></Tooltip>
          </Popconfirm>
        </Space>,
      })
    }
    return dataColumns
  }, [canWrite, fields, queryMode, result])

  if (!canRead) {
    return <div className="rd-workspace rd-permission-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有数据读取权限" /></div>
  }

  return <section className="rd-workspace rd-data-workspace">
    <div className="rd-toolbar">
      <div className="rd-toolbar-primary">
        <Select
          aria-label="数据集"
          showSearch
          optionFilterProp="label"
          value={datasetId || undefined}
          placeholder="选择数据集"
          loading={metaLoading}
          options={datasets.map((item) => ({ value: item.id, label: item.name }))}
          onChange={setDatasetId}
        />
        <Select
          aria-label="数据表"
          showSearch
          optionFilterProp="label"
          value={tableName || undefined}
          placeholder="选择数据表"
          loading={metaLoading}
          options={tables.map((name) => ({ value: name, label: name }))}
          onChange={setTableName}
        />
        <Segmented<QueryMode>
          value={queryMode}
          options={[
            { value: 'structured', label: '条件查询', icon: <FilterOutlined /> },
            { value: 'sql', label: 'SQL', icon: <ApiOutlined />, disabled: !canSQL },
          ]}
          onChange={setQueryMode}
        />
      </div>
      <Space size={6}>
        {canSchema && <Button icon={<ToolOutlined />} disabled={!datasetId} onClick={() => setSchemaOpen(true)}>表结构</Button>}
        {canWrite && <Button icon={<PlusOutlined />} disabled={!tableName || !fields.length} onClick={() => openRecord()}>新增记录</Button>}
        {canExport && queryMode === 'structured' && <Button icon={<DownloadOutlined />} disabled={!tableName || Boolean(exportJob && !terminalJobStates.has(exportJob.state))} onClick={() => void submitExport()}>全量导出</Button>}
        <Button type="primary" icon={<SearchOutlined />} loading={loading} disabled={!tableName || (queryMode === 'sql' && !sql.trim())} onClick={() => void runQuery()}>查询</Button>
      </Space>
    </div>

    <div className="rd-data-grid">
      <aside className="rd-schema-rail">
        <div className="rd-rail-heading">
          <span><DatabaseOutlined /> 数据对象</span>
          <Button type="text" size="small" aria-label="刷新元数据" icon={<ReloadOutlined />} onClick={() => {
            if (datasetId) void loadTables(datasetId)
            if (datasetId && tableName) void loadSchema(datasetId, tableName)
          }} />
        </div>
        <div className="rd-table-list">
          {tables.map((name) => <button key={name} type="button" className={name === tableName ? 'active' : ''} onClick={() => setTableName(name)}>
            <TableOutlined /><span>{name}</span>
          </button>)}
          {!tables.length && !metaLoading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={datasetId ? '暂无可访问的数据表' : '请选择数据集'} />}
        </div>
        <div className="rd-rail-heading rd-fields-heading"><span><FieldBinaryOutlined /> 字段</span><Tag>{fields.length}</Tag></div>
        <div className="rd-field-list">
          {fields.map((field) => <button key={field.name} type="button" onClick={() => setSelectedFields((current) => current.includes(field.name) ? current.filter((name) => name !== field.name) : [...current, field.name])}>
            <Checkbox checked={!selectedFields.length || selectedFields.includes(field.name)} />
            <span><b>{field.name}</b><small>{field.dataType}</small></span>
            {field.primaryKey && <Tag color="blue">PK</Tag>}
          </button>)}
        </div>
      </aside>

      <main className="rd-query-stage">
        {queryMode === 'structured' ? <div className="rd-query-builder">
          <div className="rd-query-row">
            <Select mode="multiple" maxTagCount="responsive" value={selectedFields} placeholder="全部字段" options={fields.map((field) => ({ value: field.name, label: field.name }))} onChange={setSelectedFields} />
            <Select allowClear value={orderField || undefined} placeholder="排序字段" options={fields.map((field) => ({ value: field.name, label: field.name }))} onChange={(value) => setOrderField(value ?? '')} />
            <Segmented value={orderDirection} options={[{ value: 'ASC', label: '升序' }, { value: 'DESC', label: '降序' }]} onChange={setOrderDirection} />
          </div>
          <div className="rd-filter-list">
            {filters.map((filter, index) => {
              const operator = FILTER_OPERATORS.find((item) => item.value === filter.operator)
              return <div className="rd-filter-line" key={filter.id}>
                <span className="rd-filter-join">{index === 0 ? '筛选' : filterLogic === 'and' ? '并且' : '或者'}</span>
                <Select value={filter.field || undefined} placeholder="字段" options={fields.map((field) => ({ value: field.name, label: field.name }))} onChange={(field) => setFilters((items) => items.map((item) => item.id === filter.id ? { ...item, field } : item))} />
                <Select value={filter.operator} options={FILTER_OPERATORS.map(({ value, label }) => ({ value, label }))} onChange={(operator) => setFilters((items) => items.map((item) => item.id === filter.id ? { ...item, operator, value: '' } : item))} />
                {!operator?.unary && <Input value={filter.value} placeholder={operator?.multiple ? '多个值用逗号分隔' : '值'} onChange={(event) => setFilters((items) => items.map((item) => item.id === filter.id ? { ...item, value: event.target.value } : item))} />}
                <Button danger type="text" aria-label="删除筛选条件" icon={<DeleteOutlined />} onClick={() => setFilters((items) => items.filter((item) => item.id !== filter.id))} />
              </div>
            })}
            <Space size={6}>
              <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => setFilters((items) => [...items, { id: createIdempotencyKey('filter'), field: fields[0]?.name ?? '', operator: 'eq', value: '' }])}>添加条件</Button>
              {filters.length > 1 && <Segmented size="small" value={filterLogic} options={[{ value: 'and', label: '全部满足' }, { value: 'or', label: '任一满足' }]} onChange={setFilterLogic} />}
            </Space>
          </div>
        </div> : <div className="rd-sql-editor">
          <Input.TextArea aria-label="受控 SQL" value={sql} spellCheck={false} autoSize={{ minRows: 5, maxRows: 12 }} onChange={(event) => setSql(event.target.value)} onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              void runSqlQuery()
            }
          }} />
          <div><span>受控 SELECT</span><span>Ctrl + Enter 执行</span></div>
        </div>}

        {canReadJobs && <JobRecoveryControls
          kind="export"
          kindLabel="导出"
          references={exportJobReferences}
          activeId={activeExportJobId}
          recovering={recoveringExportJob}
          onRecover={(id, label) => { void refreshExportJob(id, label) }}
        />}

        {exportJob && <div className={`rd-job-strip rd-export-job state-${exportJob.state}`} data-testid="export-job-status" data-state={exportJob.state} data-job-id={exportJob.id}>
          <div className="rd-job-icon">{terminalJobStates.has(exportJob.state) ? <DownloadOutlined /> : <LoadingOutlined spin />}</div>
          <div className="rd-job-main">
            <div><b>{activeExportReference?.label || exportFileBase || '数据表'} · 全量导出</b><Tag>{exportJob.state}</Tag><code>{exportJob.id}</code></div>
            <Progress size="small" percent={parseJobProgress(exportJob.progress).percent ?? (exportJob.state === 'succeeded' ? 100 : undefined)} status={exportJob.state === 'failed' ? 'exception' : exportJob.state === 'succeeded' ? 'success' : 'active'} />
            <small>{exportJob.error || `阶段：${parseJobProgress(exportJob.progress).phase}`}</small>
          </div>
          {exportJob.state === 'succeeded' && <Space size={4}>
            <Button size="small" type="primary" icon={<DownloadOutlined />} loading={exportSaving === 'excel'} disabled={exportSaving === 'ndjson'} onClick={() => void downloadExportExcel()}>保存 Excel</Button>
            <Button size="small" icon={<DownloadOutlined />} loading={exportSaving === 'ndjson'} disabled={exportSaving === 'excel'} onClick={() => void downloadExportNdjson()}>NDJSON</Button>
          </Space>}
        </div>}

        <section className="rd-result-panel">
          <div className="rd-result-summary">
            <span><BarsOutlined /> 查询结果</span>
            {result ? <><Tag color="success">已返回</Tag><small>共 {result.total.toLocaleString()} 条</small></> : <small>设置条件后执行查询</small>}
          </div>
          <div className="rd-result-table">
            <Spin spinning={loading}>
              {result ? <Table<Record<string, unknown>>
                rowKey="__rightdataClientRowKey"
                size="small"
                bordered
                pagination={false}
                columns={resultColumns}
                dataSource={result.rows.map((row, index) => ({ ...row, __rightdataClientRowKey: `${page}-${index}` }))}
                scroll={{ x: Math.max(760, resultColumns.length * 150), y: 420 }}
              /> : <Empty className="rd-query-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={tableName ? '尚未执行查询' : '请选择数据表'} />}
            </Spin>
          </div>
          {result && queryMode === 'structured' && <div className="rd-result-footer">
            <span>第 {page} 页</span>
            <Pagination
              size="small"
              current={page}
              pageSize={pageSize}
              total={result.total}
              showSizeChanger
              pageSizeOptions={[20, 50, 100, 200]}
              showQuickJumper
              onChange={(nextPage, nextSize) => void runStructuredQuery(nextPage, nextSize)}
            />
          </div>}
        </section>
      </main>
    </div>

    <Modal
      open={recordOpen}
      title={editingRow ? '编辑记录' : '新增记录'}
      okText="保存"
      cancelText="取消"
      confirmLoading={recordSaving}
      width={620}
      onCancel={() => setRecordOpen(false)}
      onOk={() => void saveRecord()}
    >
      <Form form={recordForm} layout="vertical" className="rd-record-form"><RecordFields fields={fields} /></Form>
    </Modal>

    <Drawer open={schemaOpen} title="表结构" size={560} onClose={() => setSchemaOpen(false)} extra={<Button type="primary" icon={<PlusOutlined />} disabled={!datasetId} onClick={() => setCreateOpen(true)}>新建表</Button>}>
      {tableName ? <>
        <div className="rd-schema-toolbar">
          <span><b>{tableName}</b><small>{fields.length} 个字段</small></span>
          <Space size={4}>
            <Button size="small" icon={<PlusOutlined />} onClick={() => {
              schemaForm.setFieldsValue({ name: '', dataType: 'VARCHAR', nullable: true, default: '' })
              setSchemaAction({ kind: 'add' })
            }}>新增字段</Button>
            <Popconfirm title="删除当前数据表？" description="表内数据会一并删除。" okText="删除" cancelText="取消" onConfirm={() => void mutateSchema({ action: 'drop_table', table: tableName }, '数据表已删除')}>
              <Button danger size="small" icon={<DeleteOutlined />}>删除表</Button>
            </Popconfirm>
          </Space>
        </div>
        <Table<DataField>
          rowKey="name"
          size="small"
          pagination={false}
          dataSource={fields}
          columns={[
            { title: '字段', dataIndex: 'name', render: (name, field) => <span className="rd-schema-name"><b>{name}</b>{field.primaryKey && <Tag color="blue">PK</Tag>}{field.unique && <Tag>唯一</Tag>}</span> },
            { title: '类型', dataIndex: 'dataType', width: 160 },
            { title: '可空', dataIndex: 'nullable', width: 64, render: (value) => value ? '是' : '否' },
            { title: '操作', key: 'actions', width: 108, render: (_value, field) => <Space size={0}>
              <Tooltip title="重命名"><Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                schemaForm.setFieldsValue({ name: field.name, dataType: field.dataType, nullable: field.nullable })
                setSchemaAction({ kind: 'rename', field })
              }} /></Tooltip>
              <Tooltip title="修改类型"><Button type="text" size="small" icon={<ToolOutlined />} onClick={() => {
                schemaForm.setFieldsValue({ name: field.name, dataType: field.dataType, nullable: field.nullable })
                setSchemaAction({ kind: 'alter', field })
              }} /></Tooltip>
              <Popconfirm title={`删除字段 ${field.name}？`} okText="删除" cancelText="取消" onConfirm={() => void mutateSchema({ action: 'drop_column', table: tableName, column: field.name }, '字段已删除')}>
                <Button danger type="text" size="small" icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space> },
          ]}
        />
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择数据表" />}
    </Drawer>

    <Modal open={Boolean(schemaAction)} title={schemaAction?.kind === 'add' ? '新增字段' : schemaAction?.kind === 'rename' ? '重命名字段' : '修改字段类型'} okText="保存" cancelText="取消" confirmLoading={schemaSaving} onCancel={() => setSchemaAction(null)} onOk={() => void submitSchemaAction()}>
      <Form form={schemaForm} layout="vertical">
        {schemaAction?.kind !== 'alter' && <Form.Item name="name" label="字段名" rules={[{ required: true }]}><Input /></Form.Item>}
        {schemaAction?.kind !== 'rename' && <Form.Item name="dataType" label="字段类型" rules={[{ required: true }]}><Select showSearch options={typeOptions} /></Form.Item>}
        {schemaAction?.kind === 'add' && <>
          <Form.Item name="nullable" label="允许空值" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="default" label="默认值"><Input allowClear /></Form.Item>
        </>}
      </Form>
    </Modal>

    <Modal open={createOpen} title="新建数据表" okText="创建" cancelText="取消" width={760} confirmLoading={schemaSaving} onCancel={() => setCreateOpen(false)} onOk={() => void createTable()}>
      <Input className="rd-create-table-name" value={createTableName} placeholder="数据表名称" onChange={(event) => setCreateTableName(event.target.value)} />
      <div className="rd-draft-fields">
        {draftFields.map((field, index) => <div key={field.key} className="rd-draft-field-row">
          <Input value={field.name} placeholder="字段名" onChange={(event) => setDraftFields((items) => items.map((item) => item.key === field.key ? { ...item, name: event.target.value } : item))} />
          <Select showSearch value={field.dataType} options={typeOptions} onChange={(dataType) => setDraftFields((items) => items.map((item) => item.key === field.key ? { ...item, dataType } : item))} />
          <Tooltip title="允许空值"><Switch checked={field.nullable} checkedChildren="可空" unCheckedChildren="必填" onChange={(nullable) => setDraftFields((items) => items.map((item) => item.key === field.key ? { ...item, nullable } : item))} /></Tooltip>
          <Checkbox checked={field.primaryKey} onChange={(event) => setDraftFields((items) => items.map((item) => ({ ...item, primaryKey: item.key === field.key ? event.target.checked : false })))}>主键</Checkbox>
          <Button danger type="text" aria-label={`删除第 ${index + 1} 个字段`} icon={<DeleteOutlined />} disabled={draftFields.length === 1} onClick={() => setDraftFields((items) => items.filter((item) => item.key !== field.key))} />
        </div>)}
      </div>
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setDraftFields((items) => [...items, makeDraftField(items.length)])}>添加字段</Button>
    </Modal>
  </section>
}
