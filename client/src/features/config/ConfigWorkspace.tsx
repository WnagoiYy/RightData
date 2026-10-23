import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Collapse,
  Drawer,
  Empty,
  Input,
  InputNumber,
  message,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CONFIG_KINDS,
  KIND_LABELS,
  asObject,
  configListPath,
  configPath,
  createId,
  emptyBody,
  findLatest,
  formatError,
  idempotencyKey,
  isConflict,
  policyOf,
  toServerKind,
  toWorkspaceKind,
} from './core'
import { ResourceRenderer } from './ResourceRenderer'
import { ReportEditor } from './ReportEditor'
import { DashboardEditor } from './DashboardEditor'
import { ScreenPackageEditor } from './ScreenPackageEditor'
import type { BulletinSourceEditorHandle } from './BulletinSourceEditor'
import type {
  BulletinBody,
  ConfigListResponse,
  ConfigWorkspaceProps,
  ConfigApi,
  DashboardBody,
  MenuBody,
  QueryDefinitionBody,
  QueryResult,
  ReportBody,
  ResourceParameter,
  ResourcePreviewResponse,
  RoleBody,
  ScreenBody,
  ServerConfigKind,
  SharedConfig,
  WorkspaceKind,
} from './types'

type Draft = SharedConfig<Record<string, unknown>>

type LocalDraftSnapshot = {
  capturedAt: string
  config: Draft
}

type LocalDraftStore = Record<string, LocalDraftSnapshot[]>

const LOCAL_DRAFT_HISTORY_PREFIX = 'rightdata.config.local-history.v1.'
const LOCAL_DRAFT_HISTORY_COUNT = 6
const LOCAL_DRAFT_HISTORY_LIMIT = 1_500_000
const BULLETIN_ASSET_LIMIT = 256 * 1024
const BULLETIN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const LazyBulletinSourceEditor = lazy(async () => {
  const module = await import('./BulletinSourceEditor')
  return { default: module.BulletinSourceEditor }
})

function localDraftStorageKey(scope?: string): string | undefined {
  const value = scope?.trim()
  return value ? `${LOCAL_DRAFT_HISTORY_PREFIX}${encodeURIComponent(value)}` : undefined
}

function readDraftStore(scope?: string): LocalDraftStore {
  const key = localDraftStorageKey(scope)
  if (!key) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, snapshots]) => {
      if (!Array.isArray(snapshots)) return []
      const valid = snapshots.filter((item): item is LocalDraftSnapshot => {
        if (!item || typeof item !== 'object') return false
        const value = item as Partial<LocalDraftSnapshot>
        return typeof value.capturedAt === 'string'
          && !!value.config
          && value.config.id === id
          && typeof value.config.version === 'number'
          && !!value.config.body
          && typeof value.config.body === 'object'
          && !Array.isArray(value.config.body)
      })
      return valid.length ? [[id, valid.slice(0, LOCAL_DRAFT_HISTORY_COUNT)]] : []
    }))
  } catch {
    return {}
  }
}

function localDraftHistory(scope: string | undefined, id: string): LocalDraftSnapshot[] {
  return readDraftStore(scope)[id] ?? []
}

function recordLocalDraft(scope: string | undefined, config: Draft): LocalDraftSnapshot[] {
  const key = localDraftStorageKey(scope)
  if (!key) return []
  try {
    const store = readDraftStore(scope)
    const snapshot = { capturedAt: new Date().toISOString(), config: clone(config) }
    store[config.id] = [snapshot, ...(store[config.id] ?? []).filter((item) => item.config.version !== config.version)]
      .slice(0, LOCAL_DRAFT_HISTORY_COUNT)
    while (JSON.stringify(store).length > LOCAL_DRAFT_HISTORY_LIMIT) {
      const oldest = Object.entries(store)
        .flatMap(([id, snapshots]) => snapshots.map((item, index) => ({ id, index, capturedAt: item.capturedAt })))
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))[0]
      if (!oldest) return []
      store[oldest.id].splice(oldest.index, 1)
      if (!store[oldest.id].length) delete store[oldest.id]
    }
    localStorage.setItem(key, JSON.stringify(store))
    return store[config.id] ?? []
  } catch {
    return []
  }
}

function clearLocalDraftHistory(scope: string | undefined, id: string) {
  const key = localDraftStorageKey(scope)
  if (!key) return
  try {
    const store = readDraftStore(scope)
    delete store[id]
    localStorage.setItem(key, JSON.stringify(store))
  } catch {
    // Local history is optional and must not block shared configuration work.
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function dateText(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function kindTag(kind: ServerConfigKind) {
  const workspaceKind = toWorkspaceKind(kind)
  const color = ({ report: 'blue', dashboard: 'purple', screen: 'magenta', menu: 'cyan', bulletin: 'gold', query: 'geekblue', role: 'green', all: 'default' } as const)[workspaceKind]
  return <Tag color={color}>{KIND_LABELS[workspaceKind]}</Tag>
}

function StringTags({ value, onChange, placeholder }: { value: string[]; onChange: (value: string[]) => void; placeholder: string }) {
  return <Select mode="tags" value={value} onChange={onChange} tokenSeparators={[',', '，']} placeholder={placeholder} options={value.map((item) => ({ value: item, label: item }))} />
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`rd-config-field${wide ? ' rd-config-field-wide' : ''}`}><span>{label}</span>{children}</label>
}

function ParameterEditor({ value, onChange }: { value: ResourceParameter[]; onChange: (value: ResourceParameter[]) => void }) {
  const update = (index: number, patch: Partial<ResourceParameter>) => onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  return <div className="rd-config-array-editor">
    <div className="rd-config-section-head"><strong>筛选参数</strong><Button size="small" onClick={() => onChange([...value, { key: `param${value.length + 1}`, label: `参数 ${value.length + 1}`, type: 'text' }])}>添加参数</Button></div>
    {!value.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无筛选参数" /> : value.map((parameter, index) => <div className="rd-config-array-row rd-config-parameter-row" key={`${parameter.key}-${index}`}>
      <Input aria-label="参数标识" value={parameter.key} placeholder="参数标识" onChange={(event) => update(index, { key: event.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
      <Input aria-label="参数名称" value={parameter.label} placeholder="显示名称" onChange={(event) => update(index, { label: event.target.value })} />
      <Select aria-label="参数类型" value={parameter.type} options={[
        { value: 'text', label: '文本' }, { value: 'number', label: '数字' }, { value: 'date', label: '日期' }, { value: 'select', label: '单选' }, { value: 'multiSelect', label: '多选' },
      ]} onChange={(type) => update(index, { type })} />
      <Tooltip title="必填"><Switch size="small" checked={parameter.required} onChange={(required) => update(index, { required })} /></Tooltip>
      <Button danger type="text" onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>删除</Button>
      {(parameter.type === 'select' || parameter.type === 'multiSelect') ? <Select className="rd-config-row-extra" mode="tags" value={parameter.options ?? []} placeholder="输入选项并回车" onChange={(options) => update(index, { options })} /> : null}
    </div>)}
  </div>
}

function BulletinEditor({ value, definitions, params, execute, onChange, onSave }: {
  value: BulletinBody
  definitions: SharedConfig[]
  params: Record<string, unknown>
  execute: (definitionId: string, params: Record<string, unknown>) => Promise<QueryResult>
  onChange: (value: BulletinBody) => void
  onSave: () => void
}) {
  const assetInput = useRef<HTMLInputElement>(null)
  const sourceEditor = useRef<BulletinSourceEditorHandle>(null)
  const sourceTestSequence = useRef(0)
  const [sourceReady, setSourceReady] = useState(false)
  const [formatting, setFormatting] = useState(false)
  const [testingSource, setTestingSource] = useState(false)
  const [testDefinitionId, setTestDefinitionId] = useState(value.definitionIds?.[0] ?? '')
  const [sourceResult, setSourceResult] = useState<QueryResult>()
  const [sourceError, setSourceError] = useState('')
  const definitionNames = new Map(definitions.map((item) => [item.id, item.name]))
  const boundDefinitions = (value.definitionIds ?? []).map((id) => ({ id, name: definitionNames.get(id) ?? id }))

  useEffect(() => {
    sourceTestSequence.current += 1
    if (!(value.definitionIds ?? []).includes(testDefinitionId)) setTestDefinitionId(value.definitionIds?.[0] ?? '')
    setSourceResult(undefined)
    setSourceError('')
    setTestingSource(false)
  }, [params, testDefinitionId, value.definitionIds])
  useEffect(() => () => { sourceTestSequence.current += 1 }, [])

  const formatSource = async () => {
    if (!sourceEditor.current) return
    setFormatting(true)
    try {
      const result = await sourceEditor.current.format()
      if (result === 'stale') message.warning('源码在格式化期间已更新，请重试')
      else message[result === 'changed' ? 'success' : 'info'](result === 'changed' ? 'HTML、CSS 和 JavaScript 已格式化' : '当前源码已经是规范格式')
    } catch (cause) {
      message.error(formatError(cause, '源码格式化失败'))
    } finally {
      setFormatting(false)
    }
  }

  const testSource = async () => {
    if (!testDefinitionId) return
    const sequence = ++sourceTestSequence.current
    setTestingSource(true)
    setSourceError('')
    setSourceResult(undefined)
    try {
      const result = await execute(testDefinitionId, params)
      if (sequence === sourceTestSequence.current) setSourceResult(result)
    } catch (cause) {
      if (sequence !== sourceTestSequence.current) return
      const error = formatError(cause, '数据源测试失败')
      setSourceError(error)
      message.error(error)
    } finally {
      if (sequence === sourceTestSequence.current) setTestingSource(false)
    }
  }

  const addImageAsset = async (file?: File) => {
    if (!file) return
    if (!BULLETIN_IMAGE_TYPES.has(file.type)) { message.warning('仅支持 PNG、JPEG、WebP 或 GIF 图片'); return }
    if (file.size > BULLETIN_ASSET_LIMIT) { message.warning('图片素材不能超过 256 KiB'); return }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'))
        reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
        reader.readAsDataURL(file)
      })
      const tag = `<img src="${dataUrl}" alt="${escapeHtmlAttribute(file.name)}">`
      const html = `${value.html ?? ''}${tag}`
      if (JSON.stringify({ ...value, html }).length > 900_000) { message.warning('插入后配置接近服务端 1 MiB 限制，请压缩图片'); return }
      if (!sourceEditor.current?.insertText(tag)) { message.warning('源码编辑器尚未就绪'); return }
      message.success('图片素材已插入光标位置')
    } catch (cause) {
      message.error(formatError(cause, '图片素材读取失败'))
    } finally {
      if (assetInput.current) assetInput.current.value = ''
    }
  }
  return <div className="rd-config-form-grid">
    <Field label="简介" wide><Input.TextArea rows={2} value={value.description} onChange={(event) => onChange({ ...value, description: event.target.value })} /></Field>
    <div className="rd-config-field-wide"><ParameterEditor value={value.parameters ?? []} onChange={(parameters) => onChange({ ...value, parameters })} /></div>
    <div className="rd-config-source-test rd-config-field-wide">
      <div className="rd-config-section-head"><strong>数据源测试</strong><Space.Compact><Select aria-label="测试数据源" value={testDefinitionId || undefined} placeholder="选择已绑定查询" options={boundDefinitions.map((item) => ({ value: item.id, label: item.name }))} onChange={setTestDefinitionId} /><Button loading={testingSource} disabled={!testDefinitionId} onClick={() => void testSource()}>测试</Button></Space.Compact></div>
      {sourceError ? <Alert type="error" showIcon message={sourceError} /> : null}
      {sourceResult ? <div className="rd-config-source-result"><Tag color="success">{sourceResult.total} 条</Tag><Table size="small" pagination={false} scroll={{ x: true, y: 180 }} rowKey="__key" dataSource={sourceResult.rows.map((row, index) => ({ ...row, __key: index }))} columns={sourceResult.fields.map((field) => ({ title: field.name, dataIndex: field.name, ellipsis: true, render: (cell: unknown) => cell == null ? '' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell) }))} /></div> : null}
    </div>
    <div className="rd-config-source rd-config-field-wide">
      <div className="rd-config-section-head"><strong>HTML / CSS / JavaScript</strong><Space size={4}><Button size="small" loading={formatting} disabled={!sourceReady} onClick={() => void formatSource()}>格式化</Button><Button size="small" disabled={!sourceReady} onClick={() => assetInput.current?.click()}>插入图片</Button><input ref={assetInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void addImageAsset(event.target.files?.[0])} /></Space></div>
      <div className="rd-config-bulletin-source"><Suspense fallback={<div className="rd-config-editor-loading">正在加载源码编辑器…</div>}><LazyBulletinSourceEditor ref={sourceEditor} value={value.html ?? ''} definitions={boundDefinitions} parameterKeys={(value.parameters ?? []).map((item) => item.key)} onChange={(html) => onChange({ ...value, html })} onSave={onSave} onFormatRequest={() => void formatSource()} onReadyChange={setSourceReady} /></Suspense></div>
    </div>
  </div>
}

function MenuEditor({ value, menus, resources, onChange }: { value: MenuBody; menus: SharedConfig[]; resources: SharedConfig[]; onChange: (value: MenuBody) => void }) {
  const resource = resources.find((item) => item.id === value.resourceId)
  return <div className="rd-config-form-grid">
    <Field label="上级菜单"><Select allowClear showSearch optionFilterProp="label" value={value.parentId || undefined} options={menus.map((item) => ({ value: item.id, label: item.name }))} onChange={(parentId) => onChange({ ...value, parentId: parentId ?? '' })} /></Field>
    <Field label="排序"><InputNumber min={-9999} max={9999} value={value.order} onChange={(order) => onChange({ ...value, order: order ?? 0 })} /></Field>
    <Field label="绑定资源" wide><Select allowClear showSearch optionFilterProp="label" value={value.resourceId || undefined} options={resources.map((item) => ({ value: item.id, label: `${item.name} · ${KIND_LABELS[toWorkspaceKind(item.kind)]}` }))} onChange={(resourceId) => {
      const next = resources.find((item) => item.id === resourceId)
      onChange({ ...value, resourceId: resourceId ?? '', resourceKind: (next?.kind ?? '') as MenuBody['resourceKind'] })
    }} /></Field>
    <Field label="资源类型"><Input disabled value={resource ? KIND_LABELS[toWorkspaceKind(resource.kind)] : '目录'} /></Field>
  </div>
}

function QueryEditor({ value, onChange }: { value: QueryDefinitionBody; onChange: (value: QueryDefinitionBody) => void }) {
  const [queryText, setQueryText] = useState(() => JSON.stringify(value.query ?? {}, null, 2))
  const [queryError, setQueryError] = useState('')
  useEffect(() => { setQueryText(JSON.stringify(value.query ?? {}, null, 2)); setQueryError('') }, [value.query])
  const applyQuery = () => {
    try { onChange({ ...value, sql: '', query: asObject(JSON.parse(queryText)) }); setQueryError('') } catch { setQueryError('结构化查询必须是 JSON 对象') }
  }
  return <div className="rd-config-form-grid">
    <Field label="数据集标识" wide><Input value={value.datasetId} onChange={(event) => onChange({ ...value, datasetId: event.target.value })} placeholder="受权限控制的数据集 ID" /></Field>
    <Field label="访问权限" wide><StringTags value={value.permissions ?? []} onChange={(permissions) => onChange({ ...value, permissions })} placeholder="输入权限标识并回车" /></Field>
    <Field label="受控 SQL" wide><Input.TextArea className="rd-config-code" rows={10} value={value.sql} onChange={(event) => onChange({ ...value, sql: event.target.value, query: undefined })} placeholder="使用命名参数的 SELECT 查询" /></Field>
    <Field label="结构化查询 JSON" wide><Input.TextArea className="rd-config-code" rows={8} value={queryText} status={queryError ? 'error' : undefined} onChange={(event) => setQueryText(event.target.value)} onBlur={applyQuery} /></Field>
    {queryError ? <Alert className="rd-config-field-wide" type="error" showIcon message={queryError} /> : null}
  </div>
}

function RoleEditor({ value, onChange }: { value: RoleBody; onChange: (value: RoleBody) => void }) {
  return <div className="rd-config-form-grid"><Field label="说明" wide><Input.TextArea rows={3} value={value.description} onChange={(event) => onChange({ ...value, description: event.target.value })} /></Field><Field label="权限标识" wide><StringTags value={value.permissions ?? []} onChange={(permissions) => onChange({ ...value, permissions })} placeholder="输入权限标识并回车" /></Field></div>
}

function RawJsonEditor({ value, onChange }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [error, setError] = useState('')
  useEffect(() => { setText(JSON.stringify(value, null, 2)); setError('') }, [value])
  const apply = () => {
    try { onChange(asObject(JSON.parse(text))); setError('') } catch { setError('请输入有效的 JSON 对象') }
  }
  return <div><Input.TextArea className="rd-config-code" rows={18} value={text} status={error ? 'error' : undefined} spellCheck={false} onChange={(event) => setText(event.target.value)} onBlur={apply} />{error ? <div className="rd-config-json-error">{error}</div> : null}</div>
}

function EditorBody({ api, draft, items, definitions, previewParams, executePreview, onChange, onSave }: {
  api: ConfigApi
  draft: Draft
  items: SharedConfig[]
  definitions: SharedConfig[]
  previewParams: Record<string, unknown>
  executePreview: (definitionId: string, params: Record<string, unknown>) => Promise<QueryResult>
  onChange: (body: Record<string, unknown>) => void
  onSave: () => void
}) {
  const workspaceKind = toWorkspaceKind(draft.kind)
  const body = draft.body
  if (workspaceKind === 'report') return <ReportEditor api={api} value={body as ReportBody} definitions={definitions} resources={items.filter((item) => ['report', 'dashboard', 'h5', 'screen'].includes(item.kind))} onChange={(value) => onChange(value as unknown as Record<string, unknown>)} />
  if (workspaceKind === 'dashboard') return <DashboardEditor value={body as DashboardBody} definitions={definitions} onChange={(value) => onChange(value as unknown as Record<string, unknown>)} />
  if (workspaceKind === 'screen') return <ParameterEditor value={(body as ScreenBody).parameters ?? []} onChange={(parameters) => onChange({ ...body, parameters })} />
  if (workspaceKind === 'bulletin') return <BulletinEditor value={body as BulletinBody} definitions={definitions} params={previewParams} execute={executePreview} onChange={(value) => onChange(value as unknown as Record<string, unknown>)} onSave={onSave} />
  if (workspaceKind === 'menu') return <MenuEditor value={body as MenuBody} menus={items.filter((item) => item.kind === 'menu' && item.id !== draft.id)} resources={items.filter((item) => ['report', 'dashboard', 'h5', 'screen'].includes(item.kind))} onChange={(value) => onChange(value as unknown as Record<string, unknown>)} />
  if (workspaceKind === 'query') return <QueryEditor value={body as QueryDefinitionBody} onChange={(value) => onChange(value as unknown as Record<string, unknown>)} />
  return <RoleEditor value={body as RoleBody} onChange={(value) => onChange(value as unknown as Record<string, unknown>)} />
}

function ResourcePolicyEditor({ body, definitions, onChange }: { body: Record<string, unknown>; definitions: SharedConfig[]; onChange: (body: Record<string, unknown>) => void }) {
  const policy = policyOf(body)
  return <div className="rd-config-policy-bar">
    <label><span>启用</span><Switch size="small" checked={policy.enabled} onChange={(enabled) => onChange({ ...body, enabled })} /></label>
    <label><span>访问权限</span><StringTags value={policy.permissions} onChange={(permissions) => onChange({ ...body, permissions })} placeholder="输入权限标识" /></label>
    <label><span>绑定数据源</span><Select mode="multiple" allowClear showSearch optionFilterProp="label" value={policy.definitionIds} options={definitions.map((item) => ({ value: item.id, label: item.name }))} onChange={(definitionIds) => onChange({ ...body, definitionIds })} placeholder="选择可执行查询" /></label>
  </div>
}

export function ConfigWorkspace({ api, kind = 'all', onOpenResource, onChanged, historyScope, className, emptyExtra }: ConfigWorkspaceProps) {
  const [items, setItems] = useState<SharedConfig[]>([])
  const [activeKind, setActiveKind] = useState<WorkspaceKind>(kind)
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<Draft>()
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [previewParams, setPreviewParams] = useState<Record<string, unknown>>({})
  const [localHistory, setLocalHistory] = useState<LocalDraftSnapshot[]>([])
  const [screenVersion, setScreenVersion] = useState<string>()

  const load = useCallback(async () => {
    setLoading(true)
    try { setItems((await api.request<ConfigListResponse>(configListPath())).items ?? []) } catch (cause) { message.error(formatError(cause, '配置加载失败')) } finally { setLoading(false) }
  }, [api])
  useEffect(() => { void load() }, [load])
  useEffect(() => { setActiveKind(kind) }, [kind])
  useEffect(() => { setLocalHistory(draft ? localDraftHistory(historyScope, draft.id) : []) }, [draft?.id, historyScope])

  const definitions = useMemo(() => items.filter((item) => item.kind === 'query'), [items])
  const visibleItems = useMemo(() => items.filter((item) => {
    if (activeKind !== 'all' && toWorkspaceKind(item.kind) !== activeKind) return false
    return !keyword.trim() || `${item.name} ${item.id}`.toLowerCase().includes(keyword.trim().toLowerCase())
  }), [activeKind, items, keyword])

  const open = (item: SharedConfig) => {
    setScreenVersion(undefined)
    setDraft(clone(item) as Draft); setDirty(false); setConflict(false); setPreviewParams({}); setLocalHistory(localDraftHistory(historyScope, item.id))
  }
  const create = () => {
    setScreenVersion(undefined)
    const selected = activeKind === 'all' ? 'report' : activeKind
    const serverKind = toServerKind(selected)
    setDraft({ id: createId(serverKind), kind: serverKind, name: `新建${KIND_LABELS[selected]}`, body: emptyBody(selected) as unknown as Record<string, unknown>, ownerId: '', version: 0, updatedAt: '' })
    setDirty(true); setConflict(false); setPreviewParams({}); setLocalHistory([])
  }
  const changeBody = (body: Record<string, unknown>) => { setDraft((current) => current ? { ...current, body } : current); setDirty(true); setConflict(false) }
  const changeName = (name: string) => { setDraft((current) => current ? { ...current, name } : current); setDirty(true); setConflict(false) }

  const persist = async (version: number) => {
    if (!draft) return
    if (!draft.name.trim()) { message.warning('请输入配置名称'); return }
    setSaving(true)
    try {
      const saved = await api.request<SharedConfig>(configPath(draft.id), {
        method: 'PUT',
        idempotencyKey: idempotencyKey('save', draft.id),
        body: { kind: draft.kind, name: draft.name.trim(), body: draft.body, version },
      })
      setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      setDraft(clone(saved) as Draft); setLocalHistory(recordLocalDraft(historyScope, saved as Draft)); setDirty(false); setConflict(false); message.success('配置已保存'); onChanged?.(saved)
    } catch (cause) {
      if (isConflict(cause)) setConflict(true)
      else message.error(formatError(cause, '保存失败'))
    } finally { setSaving(false) }
  }
  const loadLatestDraft = async () => {
    if (!draft) return
    try {
      const latestItems = (await api.request<ConfigListResponse>(configListPath())).items ?? []
      setItems(latestItems)
      const latest = findLatest(latestItems, draft.id)
      if (!latest) { message.warning('服务端已不存在此配置'); return }
      setDraft(clone(latest) as Draft); setLocalHistory(localDraftHistory(historyScope, latest.id)); setDirty(false); setConflict(false); message.success('已加载服务器版本')
    } catch (cause) { message.error(formatError(cause, '加载服务器版本失败')) }
  }
  const overwriteLatest = async () => {
    if (!draft) return
    try {
      const latestItems = (await api.request<ConfigListResponse>(configListPath())).items ?? []
      const latest = findLatest(latestItems, draft.id)
      await persist(latest?.version ?? 0)
    } catch (cause) { message.error(formatError(cause, '读取最新版本失败')) }
  }
  const remove = async (item: SharedConfig) => {
    try {
      await api.request(configPath(item.id, item.version), { method: 'DELETE' })
      setItems((current) => current.filter((candidate) => candidate.id !== item.id)); clearLocalDraftHistory(historyScope, item.id); if (draft?.id === item.id) setDraft(undefined); message.success('已删除'); onChanged?.(null)
    } catch (cause) { message.error(isConflict(cause) ? '配置已被他人更新，列表已刷新' : formatError(cause, '删除失败')); if (isConflict(cause)) void load() }
  }
  const executePreview = async (definitionId: string, params: Record<string, unknown>): Promise<QueryResult> => {
    if (!draft || !['report', 'dashboard', 'h5', 'screen'].includes(draft.kind)) throw new Error('当前配置不可预览')
    const result = await api.request<ResourcePreviewResponse>('/api/v1/resources/preview', { method: 'POST', body: { id: draft.id, kind: draft.kind, body: draft.body, definitionId, params } })
    if (!result.data) throw new Error('查询未返回数据')
    return result.data
  }
  const restoreLocalDraft = (snapshot: LocalDraftSnapshot) => {
    setDraft((current) => current ? { ...current, name: snapshot.config.name, body: clone(snapshot.config.body) } : current)
    setDirty(true); setConflict(false); message.success(`已载入本机 V${snapshot.config.version} 内容，保存时仍校验当前服务器版本`)
  }

  const columns: ColumnsType<SharedConfig> = [
    { title: '名称', dataIndex: 'name', ellipsis: true, render: (value, record) => <button className="rd-config-name-button" type="button" onClick={() => open(record)}><strong>{value}</strong><small>{record.id}</small></button> },
    ...(activeKind === 'all' ? [{ title: '类型', dataIndex: 'kind', width: 100, render: (value: ServerConfigKind) => kindTag(value) }] : []),
    { title: '状态', width: 86, render: (_, record) => ['report', 'dashboard', 'h5', 'screen', 'menu'].includes(record.kind) ? <Tag color={asObject(record.body).enabled === true ? 'success' : 'default'}>{asObject(record.body).enabled === true ? '启用' : '停用'}</Tag> : <Tag>有效</Tag> },
    { title: '版本', dataIndex: 'version', width: 72, render: (version) => <span className="rd-config-version">V{version}</span> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 172, render: dateText },
    { title: '操作', width: 188, fixed: 'right', render: (_, record) => <Space size={0}><Button type="link" size="small" onClick={() => open(record)}>编辑</Button>{['report', 'dashboard', 'h5'].includes(record.kind) && onOpenResource ? <Button type="link" size="small" onClick={() => onOpenResource(record, {})}>打开</Button> : null}<Popconfirm title="确认删除此配置？" onConfirm={() => void remove(record)}><Button danger type="link" size="small">删除</Button></Popconfirm></Space> },
  ]

  const isResource = draft && ['report', 'dashboard', 'h5', 'screen'].includes(draft.kind)
  const previewDraft = draft?.kind === 'screen' ? { ...draft, previewVersion: screenVersion } : draft
  const editorTabs = draft ? [{
    key: 'form', label: '配置', children: <div className="rd-config-editor-scroll">
      <div className="rd-config-identity"><Field label="配置名称" wide><Input value={draft.name} maxLength={200} onChange={(event) => changeName(event.target.value)} /></Field><span>{draft.id}</span></div>
      {isResource ? <ResourcePolicyEditor body={draft.body} definitions={definitions} onChange={changeBody} /> : draft.kind === 'menu' ? <ResourcePolicyEditor body={{ ...draft.body, definitionIds: [] }} definitions={[]} onChange={(body) => { const next = { ...body }; delete next.definitionIds; changeBody(next) }} /> : null}
      <EditorBody api={api} draft={draft} items={items} definitions={definitions} previewParams={previewParams} executePreview={executePreview} onChange={changeBody} onSave={() => { if (!saving) void persist(draft.version) }} />
      {draft.kind === 'screen' ? <ScreenPackageEditor api={api} resource={draft} configDirty={dirty} selectedVersion={screenVersion} onSelect={setScreenVersion} onPublished={() => onChanged?.(draft)} /> : null}
      <Collapse ghost size="small" items={[
        { key: 'raw', label: '原始 JSON', children: <RawJsonEditor value={draft.body} onChange={changeBody} /> },
        { key: 'local-history', label: `本机保存记录${localHistory.length ? ` (${localHistory.length})` : ''}`, children: <div className="rd-config-local-history"><div className="rd-config-local-history-head"><span>仅包含当前服务实例和用户在此设备成功保存的快照。</span>{localHistory.length ? <Button type="link" size="small" onClick={() => { clearLocalDraftHistory(historyScope, draft.id); setLocalHistory([]) }}>清除</Button> : null}</div>{localHistory.length ? localHistory.map((snapshot) => <div className="rd-config-local-history-row" key={`${snapshot.config.version}:${snapshot.capturedAt}`}><div><strong>V{snapshot.config.version}</strong><span>{dateText(snapshot.capturedAt)}</span></div><Button size="small" onClick={() => restoreLocalDraft(snapshot)}>载入为草稿</Button></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此设备还没有保存记录" />}</div> },
      ]} />
    </div>,
  }] : []

  return <section className={`rd-config-workspace${className ? ` ${className}` : ''}`}>
    <div className="rd-config-toolbar">
      {kind === 'all' ? <Segmented value={activeKind} options={[{ value: 'all', label: '全部' }, ...CONFIG_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))]} onChange={(value) => setActiveKind(value as WorkspaceKind)} /> : null}
      <Input.Search className="rd-config-search" allowClear value={keyword} placeholder="搜索名称或标识" onChange={(event) => setKeyword(event.target.value)} />
      <Space size={8}><Button onClick={() => void load()} loading={loading}>刷新</Button><Button type="primary" onClick={create}>新增{activeKind === 'all' ? '配置' : KIND_LABELS[activeKind]}</Button></Space>
    </div>
    <div className="rd-config-table"><Table rowKey="id" size="small" loading={loading} columns={columns} dataSource={visibleItems} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 项` }} scroll={{ x: 820 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无配置">{emptyExtra}</Empty> }} /></div>
    <Drawer className="rd-config-drawer" open={!!draft} width="min(1180px, 96vw)" title={draft ? <div className="rd-config-drawer-title"><span>{KIND_LABELS[toWorkspaceKind(draft.kind)]}</span>{dirty ? <Tag color="warning">未保存</Tag> : <Tag color="success">V{draft.version}</Tag>}</div> : null} onClose={() => setDraft(undefined)} extra={<Space><Button onClick={() => setDraft(undefined)}>关闭</Button><Button type="primary" loading={saving} onClick={() => void persist(draft?.version ?? 0)}>保存</Button></Space>}>
      {conflict ? <Alert className="rd-config-conflict" type="warning" showIcon message="服务器版本已更新，本地草稿仍已保留。" action={<Space><Button size="small" onClick={() => void loadLatestDraft()}>加载服务器版本</Button><Button size="small" type="primary" onClick={() => void overwriteLatest()}>用本地草稿覆盖</Button></Space>} /> : null}
      {draft ? <div className={`rd-config-editor-layout${isResource ? '' : ' rd-config-editor-only'}`}>
        <Tabs className="rd-config-editor-tabs" items={editorTabs} />
        {isResource && previewDraft ? <div className="rd-config-preview"><div className="rd-config-preview-head"><strong>预览</strong><Space size={8}><span>{dirty ? '未保存草稿' : '当前配置'}</span>{onOpenResource ? <Button size="small" disabled={draft.kind === 'screen' && !screenVersion} onClick={() => onOpenResource(previewDraft, previewParams)}>独立预览</Button> : null}</Space></div><ResourceRenderer preview resource={previewDraft} params={previewParams} onParamsChange={setPreviewParams} execute={executePreview} /></div> : null}
      </div> : null}
    </Drawer>
  </section>
}

export default ConfigWorkspace

