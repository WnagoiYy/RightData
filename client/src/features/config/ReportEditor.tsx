import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Select, Space, Switch } from 'antd'
import { formatError } from './core'
import type { ConfigApi, QueryDefinitionBody, ReportBody, ReportColumn, ReportDrilldown, ReportParameterBinding, ReportSort, ResourceParameter, SharedConfig } from './types'

type SchemaField = { name: string; dataType: string; nullable: boolean; primaryKey?: boolean; unique?: boolean }
type StructuredTarget = { definitionId: string; datasetId: string; table: string }

export type ReportEditorProps = {
  api: ConfigApi
  value: ReportBody
  definitions: SharedConfig[]
  resources: SharedConfig[]
  onChange: (value: ReportBody) => void
}

function structuredTarget(definition?: SharedConfig): StructuredTarget | undefined {
  if (!definition || definition.kind !== 'query') return undefined
  const body = definition.body as QueryDefinitionBody
  if (typeof body.sql === 'string' && body.sql.trim()) return undefined
  const query = body.query
  if (!query || typeof query !== 'object' || Array.isArray(query)) return undefined
  const table = typeof query.table === 'string' ? query.table.trim() : ''
  const datasetId = typeof query.datasetId === 'string' ? query.datasetId.trim() : (body.datasetId ?? '').trim()
  const aggregates = Array.isArray(query.aggregates) ? query.aggregates : []
  const groupBy = Array.isArray(query.groupBy) ? query.groupBy : []
  if (!datasetId || !table || aggregates.length || groupBy.length) return undefined
  return { definitionId: definition.id, datasetId, table }
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <div className="rd-config-field-wide rd-config-array-editor"><div className="rd-config-section-head"><strong>{title}</strong>{action}</div>{children}</div>
}

function Parameters({ value, bindings, onChange }: {
  value: ResourceParameter[]
  bindings: ReportParameterBinding[]
  onChange: (value: ResourceParameter[], bindings: ReportParameterBinding[]) => void
}) {
  const update = (index: number, patch: Partial<ResourceParameter>) => {
    const previousKey = value[index]?.key ?? ''
    const nextKey = patch.key ?? previousKey
    const nextBindings = nextKey === previousKey ? bindings : bindings.map((item) => item.parameterKey === previousKey ? { ...item, parameterKey: nextKey } : item)
    onChange(value.map((item, current) => current === index ? { ...item, ...patch } : item), nextBindings)
  }
  const bindingFor = (key: string) => bindings.find((item) => item.parameterKey === key)?.queryParameterKey ?? ''
  const setBinding = (key: string, queryParameterKey: string) => onChange(value, [
    ...bindings.filter((item) => item.parameterKey !== key),
    ...(queryParameterKey.trim() ? [{ parameterKey: key, queryParameterKey: queryParameterKey.trim() }] : []),
  ])
  const defaultControl = (parameter: ResourceParameter, index: number) => {
    const setDefault = (defaultValue: unknown) => update(index, { defaultValue })
    if (parameter.type === 'number') return <InputNumber aria-label={`默认值 ${parameter.label || parameter.key}`} value={typeof parameter.defaultValue === 'number' ? parameter.defaultValue : undefined} placeholder="默认值" onChange={setDefault} />
    if (parameter.type === 'date') return <Input aria-label={`默认值 ${parameter.label || parameter.key}`} type="date" value={typeof parameter.defaultValue === 'string' ? parameter.defaultValue : ''} onChange={(event) => setDefault(event.target.value)} />
    if (parameter.type === 'select' || parameter.type === 'multiSelect') return <Select aria-label={`默认值 ${parameter.label || parameter.key}`} allowClear mode={parameter.type === 'multiSelect' ? 'multiple' : undefined} value={parameter.defaultValue as string | string[] | undefined} options={(parameter.options ?? []).map((option) => ({ value: option, label: option }))} placeholder="默认值" onChange={setDefault} />
    return <Input aria-label={`默认值 ${parameter.label || parameter.key}`} value={typeof parameter.defaultValue === 'string' ? parameter.defaultValue : ''} placeholder="默认值" onChange={(event) => setDefault(event.target.value)} />
  }
  return <Section title="筛选参数" action={<Button size="small" onClick={() => onChange([...value, { key: `param${value.length + 1}`, label: `参数 ${value.length + 1}`, type: 'text' }], bindings)}>添加参数</Button>}>
    {!value.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无筛选参数" /> : value.map((parameter, index) => <div key={`parameter-${index}`} className="rd-config-array-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
      <Input aria-label="参数标识" value={parameter.key} placeholder="参数标识" onChange={(event) => update(index, { key: event.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
      <Input aria-label="参数名称" value={parameter.label} placeholder="显示名称" onChange={(event) => update(index, { label: event.target.value })} />
      <Select aria-label="参数类型" value={parameter.type} options={[{ value: 'text', label: '文本' }, { value: 'number', label: '数字' }, { value: 'date', label: '日期' }, { value: 'select', label: '单选' }, { value: 'multiSelect', label: '多选' }]} onChange={(type) => update(index, { type })} />
      <Input aria-label={`查询参数 ${parameter.label || parameter.key}`} value={bindingFor(parameter.key)} placeholder="绑定查询参数" onChange={(event) => setBinding(parameter.key, event.target.value)} />
      {defaultControl(parameter, index)}
      <Checkbox checked={parameter.required} onChange={(event) => update(index, { required: event.target.checked })}>必填</Checkbox>
      <Button danger type="text" onClick={() => onChange(value.filter((_, current) => current !== index), bindings.filter((item) => item.parameterKey !== parameter.key))}>删除</Button>
      {(parameter.type === 'select' || parameter.type === 'multiSelect') ? <Select mode="tags" value={parameter.options ?? []} placeholder="选项" onChange={(options) => update(index, { options })} /> : null}
    </div>)}
  </Section>
}

function encodeMappings(drilldown: ReportDrilldown): string {
  return drilldown.parameterMappings.map((item) => `${item.sourceField}=${item.targetParameter}`).join(', ')
}

function decodeMappings(value: string): ReportDrilldown['parameterMappings'] {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf('=')
    return separator < 0 ? { sourceField: item, targetParameter: item } : { sourceField: item.slice(0, separator).trim(), targetParameter: item.slice(separator + 1).trim() }
  }).filter((item) => item.sourceField && item.targetParameter)
}

export function ReportEditor({ api, value, definitions, resources, onChange }: ReportEditorProps) {
  const [schema, setSchema] = useState<SchemaField[]>([])
  const [schemaError, setSchemaError] = useState('')
  const [schemaLoading, setSchemaLoading] = useState(false)
  const primary = definitions.find((item) => item.id === value.primaryDefinitionId)
  const target = useMemo(() => structuredTarget(primary), [primary])
  const columns = value.columns ?? []
  const parameters = value.parameters ?? []
  const bindings = value.parameterBindings ?? []
  const sorts = value.defaultSorts ?? []
  const drilldowns = value.drilldowns ?? []

  useEffect(() => {
    setSchema([]); setSchemaError('')
    if (!target) { setSchemaLoading(false); return }
    const controller = new AbortController()
    setSchemaLoading(true)
    api.request<{ fields: SchemaField[] }>(`/api/v1/datasets/${encodeURIComponent(target.datasetId)}/tables/${encodeURIComponent(target.table)}/schema`, { signal: controller.signal })
      .then((response) => setSchema(response.fields ?? []))
      .catch((cause) => { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setSchemaError(formatError(cause, '表结构加载失败')) })
      .finally(() => { if (!controller.signal.aborted) setSchemaLoading(false) })
    return () => controller.abort()
  }, [api, target?.datasetId, target?.table])

  const updateColumn = (index: number, patch: Partial<ReportColumn>) => onChange({ ...value, columns: columns.map((item, current) => current === index ? { ...item, ...patch } : item) })
  const updateSort = (index: number, patch: Partial<ReportSort>) => onChange({ ...value, defaultSorts: sorts.map((item, current) => current === index ? { ...item, ...patch } : item) })
  const updateDrill = (index: number, patch: Partial<ReportDrilldown>) => onChange({ ...value, drilldowns: drilldowns.map((item, current) => current === index ? { ...item, ...patch } : item) })
  const selectableFields = columns.filter((column) => column.key).map((column) => ({ value: column.key, label: column.title || column.key }))
  const primaryKeys = schema.filter((field) => field.primaryKey).map((field) => field.name)
  const maintenanceEligible = !!target && !schemaLoading && !schemaError && primaryKeys.length > 0
  const maintenanceEnabled = !!value.maintenance
  const setMaintenance = (enabled: boolean) => {
    if (!enabled) { onChange({ ...value, maintenance: undefined }); return }
    if (!target || !maintenanceEligible) return
    onChange({ ...value, maintenance: {
      definitionId: target.definitionId, datasetId: target.datasetId, table: target.table,
      keyFields: primaryKeys, writableFields: schema.map((field) => field.name), allowInsert: false, allowUpdate: false, allowDelete: false,
    } })
  }

  return <div className="rd-config-form-grid">
    <label className="rd-config-field"><span>默认查询</span><Select allowClear showSearch optionFilterProp="label" value={value.primaryDefinitionId || undefined} options={definitions.map((item) => ({ value: item.id, label: item.name }))} onChange={(primaryDefinitionId) => {
      const definitionIds = primaryDefinitionId && !(value.definitionIds ?? []).includes(primaryDefinitionId) ? [...(value.definitionIds ?? []), primaryDefinitionId] : (value.definitionIds ?? [])
      onChange({ ...value, primaryDefinitionId, definitionIds, maintenance: value.maintenance?.definitionId === primaryDefinitionId ? value.maintenance : undefined })
    }} /></label>
    <label className="rd-config-field"><span>每页条数</span><InputNumber min={1} max={500} value={value.pageSize ?? 20} onChange={(pageSize) => onChange({ ...value, pageSize: pageSize ?? 20 })} /></label>

    <Parameters value={parameters} bindings={bindings} onChange={(parameters, parameterBindings) => onChange({ ...value, parameters, parameterBindings })} />

    <Section title="显示列" action={<Button size="small" onClick={() => onChange({ ...value, columns: [...columns, { key: '', title: '', visible: true }] })}>添加列</Button>}>
      {!columns.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未配置时按查询字段显示" /> : columns.map((column, index) => <div key={`column-${index}`} className="rd-config-array-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))' }}>
        <Input aria-label="字段名" value={column.key} placeholder="字段名" onChange={(event) => updateColumn(index, { key: event.target.value })} />
        <Input aria-label="列标题" value={column.title} placeholder="列标题" onChange={(event) => updateColumn(index, { title: event.target.value })} />
        <Checkbox checked={column.visible !== false} onChange={(event) => updateColumn(index, { visible: event.target.checked })}>显示</Checkbox>
        <Select aria-label="对齐" value={column.align ?? 'left'} options={[{ value: 'left', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' }]} onChange={(align) => updateColumn(index, { align })} />
        <Select aria-label="格式" value={column.format ?? 'text'} options={[{ value: 'text', label: '原样' }, { value: 'number', label: '数字' }, { value: 'percent', label: '百分比' }, { value: 'date', label: '日期' }, { value: 'datetime', label: '日期时间' }]} onChange={(format) => updateColumn(index, { format })} />
        <InputNumber aria-label="小数位数" min={0} max={12} value={column.decimals} placeholder="小数位" onChange={(decimals) => updateColumn(index, { decimals: decimals ?? undefined })} />
        <Input aria-label="单位" value={column.unit} placeholder="单位" onChange={(event) => updateColumn(index, { unit: event.target.value })} />
        <InputNumber aria-label="列宽" min={60} max={800} value={column.width} placeholder="宽度" onChange={(width) => updateColumn(index, { width: width ?? undefined })} />
        <Select aria-label="汇总" allowClear value={column.summary} placeholder="不汇总" options={[{ value: 'sum', label: '合计' }, { value: 'avg', label: '平均' }, { value: 'min', label: '最小' }, { value: 'max', label: '最大' }, { value: 'count', label: '计数' }]} onChange={(summary) => updateColumn(index, { summary })} />
        <Button danger type="text" onClick={() => onChange({ ...value, columns: columns.filter((_, current) => current !== index) })}>删除</Button>
      </div>)}
    </Section>

    <Section title="默认排序" action={<Button size="small" onClick={() => onChange({ ...value, defaultSorts: [...sorts, { key: columns[0]?.key ?? '', direction: 'ascend' }] })}>添加排序</Button>}>
      {!sorts.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无默认排序" /> : sorts.map((sort, index) => <div key={`sort-${index}`} className="rd-config-array-row" style={{ gridTemplateColumns: 'minmax(120px, 1fr) 100px 48px' }}>
        <Select showSearch value={sort.key || undefined} placeholder="字段" options={selectableFields} onChange={(key) => updateSort(index, { key })} />
        <Select value={sort.direction} options={[{ value: 'ascend', label: '升序' }, { value: 'descend', label: '降序' }]} onChange={(direction) => updateSort(index, { direction })} />
        <Button danger type="text" onClick={() => onChange({ ...value, defaultSorts: sorts.filter((_, current) => current !== index) })}>删除</Button>
      </div>)}
    </Section>

    <Section title="行钻取" action={<Button size="small" onClick={() => onChange({ ...value, drilldowns: [...drilldowns, { triggerField: columns[0]?.key ?? '', targetResourceId: '', parameterMappings: [] }] })}>添加钻取</Button>}>
      {!drilldowns.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无钻取配置" /> : drilldowns.map((drilldown, index) => <div key={`drill-${index}`} className="rd-config-array-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        <Select aria-label="触发字段" showSearch value={drilldown.triggerField || undefined} placeholder="触发字段" options={selectableFields} onChange={(triggerField) => updateDrill(index, { triggerField })} />
        <Select aria-label="目标资源" showSearch optionFilterProp="label" value={drilldown.targetResourceId || undefined} placeholder="目标资源" options={resources.filter((item) => ['report', 'dashboard', 'h5'].includes(item.kind)).map((item) => ({ value: item.id, label: item.name }))} onChange={(targetResourceId) => updateDrill(index, { targetResourceId })} />
        <Input aria-label="参数映射" value={encodeMappings(drilldown)} placeholder="源字段=目标参数，多个用逗号" onChange={(event) => updateDrill(index, { parameterMappings: decodeMappings(event.target.value) })} />
        <Button danger type="text" onClick={() => onChange({ ...value, drilldowns: drilldowns.filter((_, current) => current !== index) })}>删除</Button>
      </div>)}
    </Section>

    <Section title="记录维护" action={<Switch checked={maintenanceEnabled} disabled={!maintenanceEnabled && !maintenanceEligible} onChange={setMaintenance} />}>
      {!target ? <Alert type="info" showIcon message="仅直接查询单表的结构化查询可启用记录维护" /> : schemaError ? <Alert type="error" showIcon message={schemaError} /> : !schemaLoading && !primaryKeys.length ? <Alert type="warning" showIcon message="目标表没有主键，不能启用记录维护" /> : maintenanceEnabled && value.maintenance ? <Space wrap>
        <Checkbox checked={value.maintenance.allowInsert} onChange={(event) => onChange({ ...value, maintenance: { ...value.maintenance!, allowInsert: event.target.checked } })}>新增</Checkbox>
        <Checkbox checked={value.maintenance.allowUpdate} onChange={(event) => onChange({ ...value, maintenance: { ...value.maintenance!, allowUpdate: event.target.checked } })}>编辑</Checkbox>
        <Checkbox checked={value.maintenance.allowDelete} onChange={(event) => onChange({ ...value, maintenance: { ...value.maintenance!, allowDelete: event.target.checked } })}>删除</Checkbox>
        <Select mode="multiple" value={value.maintenance.writableFields} options={schema.map((field) => ({ value: field.name, label: field.name }))} onChange={(writableFields) => onChange({ ...value, maintenance: { ...value.maintenance!, writableFields } })} />
      </Space> : null}
    </Section>
  </div>
}
