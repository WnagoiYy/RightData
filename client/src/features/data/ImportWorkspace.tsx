import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Progress,
  Radio,
  Segmented,
  Select,
  Spin,
  Switch,
  Table,
  Tag,
  Upload,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  FileExcelOutlined,
  LoadingOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx/dist/xlsx.full.min.js'
import {
  DATA_TYPES,
  createImportCsv,
  encodePath,
  errorMessage,
  formatBytes,
  formatCell,
  hasPermission,
  normalizeParsedRows,
  parseJobProgress,
  settleOperation,
  stableOperation,
} from './data-utils'
import { JobRecoveryControls, useRecoverableJob } from './job-recovery'
import type {
  DataFeatureProps,
  DataField,
  DataJob,
  DatasetSummary,
  ImportMapping,
  JobState,
  ParsedDataFile,
  UploadReceipt,
} from './types'
import './data-workspace.css'

type ImportTargetMode = 'existing' | 'create'
type ImportMode = 'append' | 'merge' | 'skip_existing' | 'replace_where' | 'replace_all'

type ParsedWorkbook = {
  file: File
  sheets: Record<string, unknown[][]>
  sheetNames: string[]
}

const terminalStates = new Set<JobState>(['succeeded', 'failed', 'canceled', 'expired'])

function jobResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return jobResult(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function fileExtension(name: string): string {
  return name.split('.').pop()?.toLocaleLowerCase() ?? ''
}

function usableUpload(receipt: UploadReceipt | null | undefined): receipt is UploadReceipt {
  return Boolean(receipt?.uploadId && Date.parse(receipt.expiresAt) > Date.now() + 60_000)
}

function uploadStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

async function fileDigest(file: File): Promise<string> {
  const data = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function cachedUpload(taskScope: string | undefined, fingerprint: string): UploadReceipt | null {
  if (!taskScope) return null
  const key = `rightdata:import-upload:v2:${encodeURIComponent(taskScope)}:${fingerprint}`
  try {
    const encoded = uploadStorage()?.getItem(key)
    if (!encoded) return null
    const receipt = JSON.parse(encoded) as UploadReceipt
    if (usableUpload(receipt) && receipt.sha256.toLocaleLowerCase() === fingerprint) return receipt
    uploadStorage()?.removeItem(key)
  } catch {
    // A fresh upload remains available when persistent storage is unavailable.
  }
  return null
}

function cacheUpload(taskScope: string | undefined, fingerprint: string, receipt: UploadReceipt): void {
  if (!taskScope) return
  try {
    uploadStorage()?.setItem(`rightdata:import-upload:v2:${encodeURIComponent(taskScope)}:${fingerprint}`, JSON.stringify(receipt))
  } catch {
    // The component-level cache still protects retries for this session.
  }
}

export function ImportWorkspace({ api, permissions, taskScope }: DataFeatureProps) {
  const { message } = App.useApp()
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [tables, setTables] = useState<string[]>([])
  const [targetFields, setTargetFields] = useState<DataField[]>([])
  const [datasetId, setDatasetId] = useState('')
  const [tableName, setTableName] = useState('')
  const [targetMode, setTargetMode] = useState<ImportTargetMode>('existing')
  const [newTableName, setNewTableName] = useState('')
  const [importMode, setImportMode] = useState<ImportMode>('append')
  const [keyFields, setKeyFields] = useState<string[]>([])
  const [conditionField, setConditionField] = useState('')
  const [conditionValue, setConditionValue] = useState('')
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null)
  const [sheetName, setSheetName] = useState('')
  const [parsed, setParsed] = useState<ParsedDataFile | null>(null)
  const [mappings, setMappings] = useState<ImportMapping[]>([])
  const [parsing, setParsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const uploadCache = useRef<{ fingerprint: string; receipt: UploadReceipt } | null>(null)

  const canWrite = hasPermission(permissions, 'data.write')
  const canSchema = hasPermission(permissions, 'schema.manage')
  const canReadJobs = hasPermission(permissions, 'jobs.read')
  const canCancelJobs = hasPermission(permissions, 'jobs.cancel')
  const reportJobError = useCallback((value: string) => { message.error(value) }, [message])
  const {
    job,
    setJob,
    references: jobReferences,
    activeId: activeJobId,
    activeReference,
    recovering: recoveringJob,
    recover: refreshJob,
    rememberSubmitted,
    clearCurrent: clearJob,
  } = useRecoverableJob({
    api,
    canReadJobs,
    kind: 'import',
    taskScope,
    fallbackLabel: '导入任务',
    onError: reportJobError,
  })

  useEffect(() => {
    uploadCache.current = null
  }, [taskScope])

  const loadDatasets = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await api.request<{ datasets: DatasetSummary[] }>('/api/v1/datasets', { signal })
      setDatasets(response.datasets ?? [])
      setDatasetId((current) => current || response.datasets?.[0]?.id || '')
    } catch (error) {
      if (!signal?.aborted) message.error(errorMessage(error))
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
    setTargetFields([])
    if (!datasetId) return
    const controller = new AbortController()
    api.request<{ tables: string[] }>(`/api/v1/datasets/${encodePath(datasetId)}/tables`, { signal: controller.signal })
      .then((response) => {
        setTables(response.tables ?? [])
        setTableName(response.tables?.[0] ?? '')
      })
      .catch((error) => { if (!controller.signal.aborted) message.error(errorMessage(error)) })
    return () => controller.abort()
  }, [api, datasetId, message])

  useEffect(() => {
    setTargetFields([])
    if (!datasetId || !tableName || targetMode !== 'existing') return
    const controller = new AbortController()
    api.request<{ fields: DataField[] }>(`/api/v1/datasets/${encodePath(datasetId)}/tables/${encodePath(tableName)}/schema`, { signal: controller.signal })
      .then((response) => setTargetFields(response.fields ?? []))
      .catch((error) => { if (!controller.signal.aborted) message.error(errorMessage(error)) })
    return () => controller.abort()
  }, [api, datasetId, message, tableName, targetMode])

  useEffect(() => {
    if (!parsed) {
      setMappings([])
      return
    }
    setMappings(parsed.headers.map((source, index) => {
      const target = targetMode === 'create'
        ? source
        : targetFields.find((field) => field.name.toLocaleLowerCase() === source.toLocaleLowerCase())?.name ?? ''
      const existing = mappings.find((mapping) => mapping.source === source)
      return {
        source,
        target: existing?.target || target,
        dataType: existing?.dataType || parsed.inferredTypes[index] || 'VARCHAR',
        included: existing?.included ?? Boolean(target),
      }
    }))
  // Mapping is intentionally rebuilt when the target schema changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, targetFields, targetMode])

  const parseSheet = useCallback((source: ParsedWorkbook, nextSheet: string) => {
    const matrix = source.sheets[nextSheet]
    const normalized = normalizeParsedRows(source.file.name, nextSheet, matrix)
    setSheetName(nextSheet)
    setParsed(normalized)
    clearJob()
  }, [clearJob])

  const parseFile = async (file: File) => {
    const extension = fileExtension(file.name)
    if (!['csv', 'xlsx', 'xls'].includes(extension)) {
      message.error('请选择 CSV、XLSX 或 XLS 文件')
      return
    }
    setParsing(true)
    try {
      const bytes = await file.arrayBuffer()
      const source = XLSX.read(bytes, { type: 'array', raw: true, cellDates: true, codepage: 65001 })
      const sheets: Record<string, unknown[][]> = {}
      for (const name of source.SheetNames) {
        sheets[name] = XLSX.utils.sheet_to_json(source.Sheets[name], {
          header: 1,
          raw: true,
          defval: null,
          blankrows: false,
        }) as unknown[][]
      }
      if (!source.SheetNames.length) throw new Error('文件中没有可读取的工作表')
      const next: ParsedWorkbook = { file, sheets, sheetNames: source.SheetNames }
      setWorkbook(next)
      parseSheet(next, source.SheetNames[0])
      message.success(`已解析 ${file.name}`)
    } catch (error) {
      setWorkbook(null)
      setParsed(null)
      message.error(errorMessage(error))
    } finally {
      setParsing(false)
    }
  }

  const selectedMappings = useMemo(() => mappings.filter((mapping) => mapping.included && mapping.target), [mappings])
  const availableTargetNames = targetMode === 'create' ? selectedMappings.map((mapping) => mapping.target) : targetFields.map((field) => field.name)

  const submitImport = async () => {
    if (!parsed || !datasetId) return
    const target = targetMode === 'create' ? newTableName.trim() : tableName
    if (!target) {
      message.warning('请选择或输入目标数据表')
      return
    }
    if (!selectedMappings.length) {
      message.warning('至少需要映射一个字段')
      return
    }
    if ((importMode === 'merge' || importMode === 'skip_existing') && !keyFields.length) {
      message.warning('当前导入方式需要选择匹配键')
      return
    }
    if (importMode === 'replace_where' && (!conditionField || conditionValue === '')) {
      message.warning('按条件替换需要填写条件字段和值')
      return
    }
    setSubmitting(true)
    let schemaOperation: ReturnType<typeof stableOperation> | undefined
    try {
      const csv = createImportCsv(parsed, mappings)
      const fingerprint = await fileDigest(csv)
      let receipt = uploadCache.current?.fingerprint === fingerprint && usableUpload(uploadCache.current.receipt)
        ? uploadCache.current.receipt
        : cachedUpload(taskScope, fingerprint)
      if (!receipt) {
        receipt = await api.upload<UploadReceipt>('/api/v1/uploads', csv, { fields: { purpose: 'import' } })
        if (receipt.sha256.toLocaleLowerCase() !== fingerprint) throw new Error('上传文件校验失败，请重试')
        cacheUpload(taskScope, fingerprint, receipt)
      }
      uploadCache.current = { fingerprint, receipt }
      if (targetMode === 'create') {
        const compositeKey = keyFields.length > 1 ? keyFields : []
        const schemaBody = {
          action: 'create_table',
          table: target,
          fields: selectedMappings.map((mapping) => ({
            name: mapping.target,
            dataType: mapping.dataType,
            nullable: !keyFields.includes(mapping.target),
            primaryKey: keyFields.length === 1 && keyFields[0] === mapping.target,
          })),
          primaryKey: compositeKey,
        }
        schemaOperation = stableOperation('import-table', { datasetId, body: schemaBody })
        await api.request(`/api/v1/datasets/${encodePath(datasetId)}/schema:mutate`, {
          method: 'POST',
          idempotencyKey: schemaOperation.key,
          body: schemaBody,
        })
      }
      const jobBody = {
        datasetId,
        table: target,
        uploadId: receipt.uploadId,
        mode: importMode,
        columns: selectedMappings.map((mapping) => mapping.target),
        keyFields: importMode === 'merge' || importMode === 'skip_existing' ? keyFields : [],
        condition: importMode === 'replace_where' ? { field: conditionField, op: 'eq', value: conditionValue } : undefined,
      }
      const jobOperation = stableOperation('import-job', jobBody)
      const created = await api.request<{ jobId: string; state: JobState }>('/api/v1/import-jobs', {
        method: 'POST',
        idempotencyKey: jobOperation.key,
        body: jobBody,
      })
      settleOperation(jobOperation)
      if (schemaOperation) settleOperation(schemaOperation)
      const submitted = {
        id: created.jobId,
        kind: 'import',
        datasetId,
        state: created.state,
        progress: { phase: created.state },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: receipt.expiresAt,
      } satisfies DataJob
      rememberSubmitted(submitted, target)
      message.success('导入任务已提交')
      if (canReadJobs) await refreshJob(created.jobId)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  const cancelJob = async () => {
    if (!job) return
    try {
      const canceled = await api.request<DataJob>(`/api/v1/jobs/${encodePath(job.id)}/cancel`, { method: 'POST' })
      setJob(canceled)
      message.success('已请求取消任务')
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const mappingColumns: ColumnsType<ImportMapping> = [
    { title: '导入', dataIndex: 'included', width: 58, render: (value, row) => <Switch size="small" checked={value} onChange={(included) => setMappings((items) => items.map((item) => item.source === row.source ? { ...item, included } : item))} /> },
    { title: '源字段', dataIndex: 'source', ellipsis: true },
    { title: <SwapOutlined />, key: 'arrow', width: 38, align: 'center', render: () => '→' },
    { title: '目标字段', dataIndex: 'target', render: (value, row) => targetMode === 'create'
      ? <Input size="small" value={value} disabled={!row.included} onChange={(event) => setMappings((items) => items.map((item) => item.source === row.source ? { ...item, target: event.target.value } : item))} />
      : <Select size="small" allowClear showSearch optionFilterProp="label" value={value || undefined} disabled={!row.included} options={targetFields.map((field) => ({ value: field.name, label: `${field.name} · ${field.dataType}` }))} onChange={(target) => setMappings((items) => items.map((item) => item.source === row.source ? { ...item, target: target ?? '' } : item))} /> },
    ...(targetMode === 'create' ? [{ title: '字段类型', dataIndex: 'dataType', width: 150, render: (value: string, row: ImportMapping) => <Select size="small" showSearch value={value} options={DATA_TYPES.map((type) => ({ value: type, label: type }))} onChange={(dataType) => setMappings((items) => items.map((item) => item.source === row.source ? { ...item, dataType } : item))} /> }] : []),
  ]

  const previewColumns: ColumnsType<Record<string, unknown>> = parsed?.headers.map((header, index) => ({
    title: <span className="rd-column-heading"><b>{header}</b><small>{parsed.inferredTypes[index]}</small></span>,
    dataIndex: String(index),
    key: `${header}-${index}`,
    width: 150,
    ellipsis: true,
    render: (value: unknown) => value == null ? <span className="rd-null">NULL</span> : formatCell(value),
  })) ?? []

  if (!canWrite) {
    return <div className="rd-workspace rd-permission-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有数据写入权限" /></div>
  }

  const progress = parseJobProgress(job?.progress)
  const result = jobResult(job?.result)

  return <section className="rd-workspace rd-import-workspace">
    <aside className="rd-import-config">
      <div className="rd-import-target-switch">
        <Segmented<ImportTargetMode>
          block
          value={targetMode}
          options={[{ value: 'existing', label: '导入已有表' }, { value: 'create', label: '新建表导入', disabled: !canSchema }]}
          onChange={(value) => { setTargetMode(value); setKeyFields([]); clearJob() }}
        />
      </div>
      <label className="rd-control-label">数据集</label>
      <Select showSearch optionFilterProp="label" value={datasetId || undefined} placeholder="选择数据集" options={datasets.map((item) => ({ value: item.id, label: item.name }))} onChange={setDatasetId} />
      {targetMode === 'existing' ? <>
        <label className="rd-control-label">目标表</label>
        <Select showSearch optionFilterProp="label" value={tableName || undefined} placeholder="选择数据表" options={tables.map((name) => ({ value: name, label: name }))} onChange={setTableName} />
      </> : <>
        <label className="rd-control-label">新表名称</label>
        <Input value={newTableName} placeholder="例如 monthly_sales" onChange={(event) => setNewTableName(event.target.value)} />
      </>}

      <label className="rd-control-label">导入方式</label>
      <Radio.Group className="rd-import-modes" value={importMode} onChange={(event) => setImportMode(event.target.value as ImportMode)}>
        <Radio value="append">追加</Radio>
        <Radio value="merge">按键合并</Radio>
        <Radio value="skip_existing">跳过已有</Radio>
        <Radio value="replace_where">按条件替换</Radio>
        <Radio value="replace_all" disabled={!canSchema}>替换全表</Radio>
      </Radio.Group>

      {(importMode === 'merge' || importMode === 'skip_existing') && <>
        <label className="rd-control-label">匹配键</label>
        <Select mode="multiple" value={keyFields} placeholder="选择唯一字段" options={availableTargetNames.map((name) => ({ value: name, label: name }))} onChange={setKeyFields} />
      </>}
      {importMode === 'replace_where' && <div className="rd-condition-grid">
        <label className="rd-control-label">替换条件</label>
        <Select value={conditionField || undefined} placeholder="字段" options={availableTargetNames.map((name) => ({ value: name, label: name }))} onChange={setConditionField} />
        <Input value={conditionValue} placeholder="等于的值" onChange={(event) => setConditionValue(event.target.value)} />
      </div>}

      <Upload.Dragger
        className="rd-import-drop"
        accept=".csv,.xlsx,.xls"
        showUploadList={false}
        multiple={false}
        beforeUpload={(file) => {
          void parseFile(file)
          return Upload.LIST_IGNORE
        }}
      >
        {parsing ? <LoadingOutlined /> : <CloudUploadOutlined />}
        <b>{parsing ? '正在解析…' : '选择 Excel 或 CSV'}</b>
        <small>文件只在本地解析，提交时生成严格 CSV</small>
      </Upload.Dragger>

      {workbook && <div className="rd-import-file">
        <FileExcelOutlined />
        <span><b>{workbook.file.name}</b><small>{formatBytes(workbook.file.size)} · {parsed?.rows.length.toLocaleString()} 行</small></span>
      </div>}
      {workbook && workbook.sheetNames.length > 1 && <Select value={sheetName} options={workbook.sheetNames.map((name) => ({ value: name, label: name }))} onChange={(name) => parseSheet(workbook, name)} />}

      <Button type="primary" block icon={<CloudUploadOutlined />} loading={submitting} disabled={!parsed || !datasetId || !selectedMappings.length || Boolean(job && !terminalStates.has(job.state))} onClick={() => void submitImport()}>提交导入任务</Button>
    </aside>

    <main className="rd-import-stage">
      <div className="rd-import-stage-head">
        <span><b>{parsed ? `${parsed.sheetName} · 字段映射` : '字段映射'}</b><small>{parsed ? `${selectedMappings.length}/${parsed.headers.length} 个字段参与导入` : '选择文件后配置'}</small></span>
      </div>

      {canReadJobs && <JobRecoveryControls
        kind="import"
        kindLabel="导入"
        references={jobReferences}
        activeId={activeJobId}
        recovering={recoveringJob}
        onRecover={(id, label) => { void refreshJob(id, label) }}
      />}

      {job && <div className={`rd-job-strip state-${job.state}`} data-testid="import-job-status" data-state={job.state} data-job-id={job.id}>
        <div className="rd-job-icon">{job.state === 'succeeded' ? <CheckCircleOutlined /> : job.state === 'failed' || job.state === 'canceled' || job.state === 'expired' ? <CloseCircleOutlined /> : <LoadingOutlined spin />}</div>
        <div className="rd-job-main">
          <div><b>{activeReference?.label || '导入任务'} · 导入</b><Tag>{job.state}</Tag><code>{job.id}</code></div>
          <Progress size="small" percent={progress.percent ?? (job.state === 'succeeded' ? 100 : undefined)} status={job.state === 'failed' ? 'exception' : job.state === 'succeeded' ? 'success' : 'active'} />
          <small>{job.error || `阶段：${progress.phase}`}</small>
        </div>
        {result && <div className="rd-job-counts">
          <span>新增 <b>{formatCell(result.insertedRows ?? 0)}</b></span>
          <span>更新 <b>{formatCell(result.updatedRows ?? 0)}</b></span>
          <span>跳过 <b>{formatCell(result.skippedRows ?? 0)}</b></span>
        </div>}
        {canCancelJobs && !terminalStates.has(job.state) && <Button danger size="small" onClick={() => void cancelJob()}>取消</Button>}
      </div>}

      {!parsed ? <Empty className="rd-import-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择文件后在此预览和映射字段" /> : <Spin spinning={parsing}>
        {targetMode === 'existing' && !targetFields.length && <Alert type="warning" showIcon title="目标表结构尚未加载，暂不能完成字段映射" />}
        <div className="rd-mapping-table"><Table<ImportMapping> rowKey="source" size="small" bordered pagination={false} columns={mappingColumns} dataSource={mappings} scroll={{ x: 660, y: 236 }} /></div>
        <div className="rd-preview-head"><b>数据预览</b><span>显示前 {Math.min(parsed.rows.length, 50)} 行，共 {parsed.rows.length.toLocaleString()} 行</span></div>
        <Table<Record<string, unknown>>
          className="rd-preview-table"
          rowKey="__rightdataClientRowKey"
          size="small"
          bordered
          pagination={false}
          columns={previewColumns}
          dataSource={parsed.rows.slice(0, 50).map((row, rowIndex) => ({ ...Object.fromEntries(row.map((value, index) => [String(index), value])), __rightdataClientRowKey: String(rowIndex) }))}
          scroll={{ x: Math.max(720, parsed.headers.length * 150), y: 310 }}
        />
      </Spin>}
    </main>
  </section>
}
