import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Button, Empty, Input, InputNumber, Segmented, Select, Space, Switch } from 'antd'
import { createId, policyOf } from './core'
import { DASHBOARD_COLUMNS, placeDashboardWidget, resolveDashboardLayouts, updateDashboardWidgetLayout } from './dashboard-model'
import type {
  DashboardAggregation,
  DashboardBody,
  DashboardViewport,
  DashboardWidget,
  DashboardWidgetLayout,
  DashboardWidgetType,
  ResourceParameter,
  SharedConfig,
} from './types'

export type DashboardEditorProps = {
  value: DashboardBody
  definitions: SharedConfig[]
  onChange: (value: DashboardBody) => void
}

const ROW_HEIGHT = 44
const viewports: DashboardViewport[] = ['desktop', 'tablet', 'mobile']
const viewportOptions = [{ value: 'desktop', label: '桌面' }, { value: 'tablet', label: '平板' }, { value: 'mobile', label: '手机' }]
const widgetTypeOptions = [
  { value: 'metric', label: '指标' }, { value: 'table', label: '表格' }, { value: 'bar', label: '条形图' }, { value: 'line', label: '折线图' },
  { value: 'pie', label: '饼图' }, { value: 'gauge', label: '仪表盘' }, { value: 'progress', label: '进度' }, { value: 'text', label: '文本' },
]
const aggregationOptions = [
  { value: 'none', label: '首条值' }, { value: 'count', label: '计数' }, { value: 'sum', label: '求和' },
  { value: 'avg', label: '平均值' }, { value: 'min', label: '最小值' }, { value: 'max', label: '最大值' },
]

function EditorField({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`rd-dashboard-editor-field${wide ? ' rd-dashboard-editor-field-wide' : ''}`}><span>{label}</span>{children}</label>
}

function DashboardParameters({ value, onAdd, onUpdate, onRemove }: {
  value: ResourceParameter[]
  onAdd: () => void
  onUpdate: (index: number, patch: Partial<ResourceParameter>) => void
  onRemove: (index: number) => void
}) {
  return <div className="rd-dashboard-parameters">
    <div className="rd-config-section-head"><strong>筛选参数</strong><Button size="small" onClick={onAdd}>添加参数</Button></div>
    {value.length ? value.map((parameter, index) => <div className="rd-dashboard-parameter-row" key={index}>
      <Input aria-label={`参数标识 ${index + 1}`} value={parameter.key} placeholder="参数标识" onChange={(event) => onUpdate(index, { key: event.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
      <Input aria-label={`参数名称 ${index + 1}`} value={parameter.label} placeholder="显示名称" onChange={(event) => onUpdate(index, { label: event.target.value })} />
      <Select aria-label={`参数类型 ${index + 1}`} value={parameter.type} options={[{ value: 'text', label: '文本' }, { value: 'number', label: '数字' }, { value: 'date', label: '日期' }, { value: 'select', label: '单选' }, { value: 'multiSelect', label: '多选' }]} onChange={(type) => onUpdate(index, { type, defaultValue: type === 'multiSelect' ? [] : '' })} />
      <Switch aria-label={`参数必填 ${index + 1}`} size="small" checked={parameter.required} onChange={(required) => onUpdate(index, { required })} />
      <Button danger type="text" size="small" onClick={() => onRemove(index)}>删除</Button>
      <div className="rd-dashboard-parameter-default">{parameter.type === 'number' ? <InputNumber aria-label={`参数默认值 ${index + 1}`} value={typeof parameter.defaultValue === 'number' ? parameter.defaultValue : undefined} placeholder="默认值" onChange={(defaultValue) => onUpdate(index, { defaultValue: defaultValue ?? undefined })} /> : parameter.type === 'multiSelect' ? <Select aria-label={`参数默认值 ${index + 1}`} mode="multiple" allowClear value={Array.isArray(parameter.defaultValue) ? parameter.defaultValue as string[] : []} options={(parameter.options ?? []).map((option) => ({ value: option, label: option }))} placeholder="默认值" onChange={(defaultValue) => onUpdate(index, { defaultValue })} /> : parameter.type === 'select' ? <Select aria-label={`参数默认值 ${index + 1}`} allowClear value={typeof parameter.defaultValue === 'string' ? parameter.defaultValue : undefined} options={(parameter.options ?? []).map((option) => ({ value: option, label: option }))} placeholder="默认值" onChange={(defaultValue) => onUpdate(index, { defaultValue })} /> : <Input aria-label={`参数默认值 ${index + 1}`} type={parameter.type === 'date' ? 'date' : 'text'} value={typeof parameter.defaultValue === 'string' ? parameter.defaultValue : ''} placeholder="默认值" onChange={(event) => onUpdate(index, { defaultValue: event.target.value })} />}</div>
      {parameter.type === 'select' || parameter.type === 'multiSelect' ? <Select className="rd-dashboard-parameter-options" mode="tags" value={parameter.options ?? []} placeholder="输入选项并回车" onChange={(options) => onUpdate(index, { options })} /> : null}
    </div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无筛选参数" />}
  </div>
}

type Gesture = {
  widgetId: string
  action: 'move' | 'resize'
  startX: number
  startY: number
  initial: DashboardWidgetLayout
  preview: DashboardWidgetLayout
  containerWidth: number
}

function canvasWidth(viewport: DashboardViewport): string {
  return viewport === 'desktop' ? '100%' : viewport === 'tablet' ? '720px' : '360px'
}

function typeLabel(type: DashboardWidgetType): string {
  return widgetTypeOptions.find((option) => option.value === type)?.label ?? type
}

export function DashboardEditor({ value, definitions, onChange }: DashboardEditorProps) {
  const widgets = value.widgets ?? []
  const [viewport, setViewport] = useState<DashboardViewport>('desktop')
  const [selectedId, setSelectedId] = useState('')
  const [gestureLayout, setGestureLayout] = useState<DashboardWidgetLayout>()
  const canvasRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | undefined>(undefined)
  const selected = widgets.find((widget) => widget.id === selectedId) ?? widgets[0]
  const selectedIndex = selected ? widgets.findIndex((widget) => widget.id === selected.id) : -1
  const resolvedLayouts = useMemo(() => resolveDashboardLayouts(widgets, viewport), [viewport, widgets])
  const boundDefinitions = policyOf(value).definitionIds

  const changeWidgets = (next: DashboardWidget[]) => onChange({ ...value, widgets: next })
  const updateWidget = (id: string, patch: Partial<DashboardWidget>) => changeWidgets(widgets.map((widget) => widget.id === id ? { ...widget, ...patch } : widget))
  const updateLayout = (id: string, patch: Partial<DashboardWidgetLayout>) => changeWidgets(updateDashboardWidgetLayout(widgets, id, viewport, patch))
  const addWidget = () => {
    const widget: DashboardWidget = { id: createId('widget'), title: '新组件', type: 'metric', gridSpan: 1, aggregation: 'none', showLegend: true }
    setSelectedId(widget.id)
    changeWidgets([...widgets, widget])
  }
  const removeWidget = (id: string) => {
    const next = widgets.filter((widget) => widget.id !== id)
    if (selected?.id === id) setSelectedId(next[0]?.id ?? '')
    changeWidgets(next)
  }
  const moveWidgetOrder = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= widgets.length) return
    const next = [...widgets]
    ;[next[index], next[target]] = [next[target], next[index]]
    changeWidgets(next)
  }
  const setDefinition = (widget: DashboardWidget, definitionId?: string) => {
    const definitionIds = definitionId && !boundDefinitions.includes(definitionId) ? [...boundDefinitions, definitionId] : boundDefinitions
    onChange({ ...value, definitionIds, widgets: widgets.map((item) => item.id === widget.id ? { ...item, definitionId } : item) })
  }
  const setLegacyWidth = (widget: DashboardWidget, gridSpan: 1 | 2) => {
    let next = widgets.map((item) => item.id === widget.id ? { ...item, gridSpan } : item)
    for (const mode of viewports) next = updateDashboardWidgetLayout(next, widget.id, mode, { width: gridSpan === 2 ? DASHBOARD_COLUMNS[mode] : Math.ceil(DASHBOARD_COLUMNS[mode] / 2), x: 0 })
    changeWidgets(next)
  }

  const beginGesture = (event: PointerEvent<HTMLElement>, widget: DashboardWidget, action: Gesture['action']) => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const initial = resolvedLayouts[widget.id]
    gestureRef.current = { widgetId: widget.id, action, startX: event.clientX, startY: event.clientY, initial, preview: initial, containerWidth: canvasRef.current?.clientWidth ?? 1 }
    setSelectedId(widget.id); setGestureLayout(initial)
  }
  const moveGesture = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (!gesture) return
    const cellWidth = gesture.containerWidth / DASHBOARD_COLUMNS[viewport]
    const dx = Math.round((event.clientX - gesture.startX) / Math.max(1, cellWidth))
    const dy = Math.round((event.clientY - gesture.startY) / ROW_HEIGHT)
    const requested = gesture.action === 'move'
      ? { x: gesture.initial.x + dx, y: gesture.initial.y + dy }
      : { width: gesture.initial.width + dx, height: gesture.initial.height + dy }
    const preview = placeDashboardWidget(widgets, gesture.widgetId, viewport, requested)
    gesture.preview = preview
    setGestureLayout(preview)
  }
  const finishGesture = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const gesture = gestureRef.current
    if (!gesture) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    gestureRef.current = undefined; setGestureLayout(undefined)
    if (commit) changeWidgets(updateDashboardWidgetLayout(widgets, gesture.widgetId, viewport, gesture.preview))
  }
  const onWidgetKeyDown = (event: KeyboardEvent<HTMLElement>, widget: DashboardWidget) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const layout = resolvedLayouts[widget.id]
    const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    updateLayout(widget.id, event.shiftKey ? { width: layout.width + horizontal, height: layout.height + vertical } : { x: layout.x + horizontal, y: layout.y + vertical })
  }
  const setParameterBinding = (widget: DashboardWidget, dashboardKey: string, queryKey: string) => {
    const bindings = (widget.parameterBindings ?? []).filter((binding) => binding.dashboardKey !== dashboardKey)
    if (queryKey.trim()) bindings.push({ dashboardKey, queryKey: queryKey.trim() })
    updateWidget(widget.id, { parameterBindings: bindings })
  }
  const addParameter = () => onChange({ ...value, parameters: [...(value.parameters ?? []), { key: `param${(value.parameters?.length ?? 0) + 1}`, label: `参数 ${(value.parameters?.length ?? 0) + 1}`, type: 'text', defaultValue: '' }] })
  const updateParameter = (index: number, patch: Partial<ResourceParameter>) => {
    const parameters = value.parameters ?? []
    const current = parameters[index]
    if (!current) return
    const nextParameters = parameters.map((parameter, itemIndex) => itemIndex === index ? { ...parameter, ...patch } : parameter)
    let nextWidgets = widgets
    if (patch.key !== undefined && patch.key !== current.key) {
      nextWidgets = widgets.map((widget) => ({ ...widget, parameterBindings: (widget.parameterBindings ?? []).flatMap((binding) => binding.dashboardKey === current.key ? patch.key ? [{ ...binding, dashboardKey: patch.key }] : [] : [binding]) }))
    }
    onChange({ ...value, parameters: nextParameters, widgets: nextWidgets })
  }
  const removeParameter = (index: number) => {
    const parameters = value.parameters ?? []
    const removed = parameters[index]
    if (!removed) return
    onChange({ ...value, parameters: parameters.filter((_, itemIndex) => itemIndex !== index), widgets: widgets.map((widget) => ({ ...widget, parameterBindings: (widget.parameterBindings ?? []).filter((binding) => binding.dashboardKey !== removed.key) })) })
  }

  return <div className="rd-dashboard-editor">
    <div className="rd-dashboard-editor-settings">
      <EditorField label="简介" wide><Input.TextArea rows={2} value={value.description} onChange={(event) => onChange({ ...value, description: event.target.value })} /></EditorField>
      <EditorField label="主题"><Segmented value={value.theme ?? 'light'} options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={(theme) => onChange({ ...value, theme: theme as 'light' | 'dark' })} /></EditorField>
      <EditorField label="自动刷新"><Select value={value.refreshSeconds ?? 0} options={[{ value: 0, label: '关闭' }, { value: 30, label: '30 秒' }, { value: 60, label: '1 分钟' }, { value: 300, label: '5 分钟' }]} onChange={(refreshSeconds) => onChange({ ...value, refreshSeconds })} /></EditorField>
    </div>
    <DashboardParameters value={value.parameters ?? []} onAdd={addParameter} onUpdate={updateParameter} onRemove={removeParameter} />
    <div className="rd-config-section-head rd-dashboard-layout-head"><strong>布局</strong><Space size={8}><Segmented value={viewport} options={viewportOptions} onChange={(next) => setViewport(next as DashboardViewport)} /><Button size="small" type="primary" onClick={addWidget}>添加组件</Button></Space></div>
    <div className="rd-dashboard-canvas-scroll">
      <div ref={canvasRef} className={`rd-dashboard-canvas rd-dashboard-canvas-${viewport}`} style={{ width: canvasWidth(viewport), gridTemplateColumns: `repeat(${DASHBOARD_COLUMNS[viewport]}, minmax(0, 1fr))` }}>
        {widgets.map((widget) => {
          const layout = gestureRef.current?.widgetId === widget.id && gestureLayout ? gestureLayout : resolvedLayouts[widget.id]
          return <section key={widget.id} className={`rd-dashboard-canvas-widget${selected?.id === widget.id ? ' is-selected' : ''}`} style={{ gridColumn: `${layout.x + 1} / span ${layout.width}`, gridRow: `${layout.y + 1} / span ${layout.height}` }} role="button" tabIndex={0} aria-label={`布局组件 ${widget.title || widget.id}`} onClick={() => setSelectedId(widget.id)} onKeyDown={(event) => onWidgetKeyDown(event, widget)}>
            <header onPointerDown={(event) => beginGesture(event, widget, 'move')} onPointerMove={moveGesture} onPointerUp={(event) => finishGesture(event, true)} onPointerCancel={(event) => finishGesture(event, false)}><strong>{widget.title || '未命名组件'}</strong><span>{typeLabel(widget.type)}</span></header>
            <div>{layout.x + 1}, {layout.y + 1} · {layout.width}×{layout.height}</div>
            <span className="rd-dashboard-resize-handle" aria-hidden onPointerDown={(event) => beginGesture(event, widget, 'resize')} onPointerMove={moveGesture} onPointerUp={(event) => finishGesture(event, true)} onPointerCancel={(event) => finishGesture(event, false)} />
          </section>
        })}
      </div>
    </div>
    {selected ? <div className="rd-dashboard-widget-config">
      <div className="rd-dashboard-widget-main-row">
        <Input aria-label={`组件标题 ${selectedIndex + 1}`} value={selected.title} placeholder="组件标题" onChange={(event) => updateWidget(selected.id, { title: event.target.value })} />
        <Select aria-label={`组件类型 ${selected.title || selectedIndex + 1}`} value={selected.type} options={widgetTypeOptions} onChange={(type) => updateWidget(selected.id, { type: type as DashboardWidgetType })} />
        <Select aria-label={`查询定义 ${selected.title || selectedIndex + 1}`} allowClear showSearch optionFilterProp="label" disabled={selected.type === 'text'} value={selected.definitionId || undefined} placeholder="查询定义" options={definitions.map((item) => ({ value: item.id, label: item.name }))} onChange={(definitionId) => setDefinition(selected, definitionId)} />
        <Select aria-label={`组件宽度 ${selected.title || selectedIndex + 1}`} value={selected.gridSpan ?? 1} options={[{ value: 1, label: '半栏' }, { value: 2, label: '通栏' }]} onChange={(gridSpan) => setLegacyWidth(selected, gridSpan as 1 | 2)} />
        <Space.Compact><Button size="small" aria-label={`上移组件 ${selected.title || selectedIndex + 1}`} disabled={selectedIndex === 0} onClick={() => moveWidgetOrder(selectedIndex, -1)}>上移</Button><Button size="small" aria-label={`下移组件 ${selected.title || selectedIndex + 1}`} disabled={selectedIndex === widgets.length - 1} onClick={() => moveWidgetOrder(selectedIndex, 1)}>下移</Button></Space.Compact>
        <Button danger type="text" onClick={() => removeWidget(selected.id)}>删除</Button>
      </div>
      <div className="rd-dashboard-position-fields">
        <EditorField label="列"><InputNumber aria-label={`位置 X ${selected.title}`} min={1} max={DASHBOARD_COLUMNS[viewport]} value={(resolvedLayouts[selected.id]?.x ?? 0) + 1} onChange={(next) => updateLayout(selected.id, { x: (next ?? 1) - 1 })} /></EditorField>
        <EditorField label="行"><InputNumber aria-label={`位置 Y ${selected.title}`} min={1} value={(resolvedLayouts[selected.id]?.y ?? 0) + 1} onChange={(next) => updateLayout(selected.id, { y: (next ?? 1) - 1 })} /></EditorField>
        <EditorField label="宽"><InputNumber aria-label={`布局宽度 ${selected.title}`} min={1} max={DASHBOARD_COLUMNS[viewport]} value={resolvedLayouts[selected.id]?.width} onChange={(width) => updateLayout(selected.id, { width: width ?? 1 })} /></EditorField>
        <EditorField label="高"><InputNumber aria-label={`布局高度 ${selected.title}`} min={1} max={12} value={resolvedLayouts[selected.id]?.height} onChange={(height) => updateLayout(selected.id, { height: height ?? 1 })} /></EditorField>
      </div>
      {selected.type === 'text' ? <Input.TextArea rows={3} value={selected.text} placeholder="文本内容" onChange={(event) => updateWidget(selected.id, { text: event.target.value })} /> : <div className="rd-dashboard-data-fields">
        <EditorField label="数值字段"><Input aria-label={`数值字段 ${selected.title}`} value={selected.valueField} placeholder="字段名" onChange={(event) => updateWidget(selected.id, { valueField: event.target.value })} /></EditorField>
        {['bar', 'line', 'pie'].includes(selected.type) ? <EditorField label="分类字段"><Input aria-label={`分类字段 ${selected.title}`} value={selected.categoryField} placeholder="字段名" onChange={(event) => updateWidget(selected.id, { categoryField: event.target.value })} /></EditorField> : null}
        <EditorField label="汇总"><Select aria-label={`汇总方式 ${selected.title}`} value={selected.aggregation ?? 'none'} options={aggregationOptions} onChange={(aggregation) => updateWidget(selected.id, { aggregation: aggregation as DashboardAggregation })} /></EditorField>
        <EditorField label="排序字段"><Input aria-label={`排序字段 ${selected.title}`} value={selected.sortField} placeholder="不排序" onChange={(event) => updateWidget(selected.id, { sortField: event.target.value })} /></EditorField>
        <EditorField label="方向"><Select aria-label={`排序方向 ${selected.title}`} value={selected.sortDirection ?? 'asc'} options={[{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }]} onChange={(sortDirection) => updateWidget(selected.id, { sortDirection })} /></EditorField>
        <EditorField label="条数"><InputNumber aria-label={`显示条数 ${selected.title}`} min={1} max={1000} value={selected.limit} placeholder="默认" onChange={(limit) => updateWidget(selected.id, { limit: limit ?? undefined })} /></EditorField>
        {selected.type !== 'table' ? <><EditorField label="数值格式"><Select aria-label={`数值格式 ${selected.title}`} value={selected.valueFormat ?? 'number'} options={[{ value: 'number', label: '数值' }, { value: 'integer', label: '整数' }, { value: 'percent', label: '百分比' }, { value: 'compact', label: '紧凑数值' }]} onChange={(valueFormat) => updateWidget(selected.id, { valueFormat })} /></EditorField><EditorField label="小数位"><InputNumber aria-label={`小数位数 ${selected.title}`} min={0} max={6} value={selected.decimalPlaces ?? 2} onChange={(decimalPlaces) => updateWidget(selected.id, { decimalPlaces: decimalPlaces ?? 2 })} /></EditorField><EditorField label="字号"><InputNumber aria-label={`字号 ${selected.title}`} min={12} max={72} value={selected.fontSize} placeholder="默认" onChange={(fontSize) => updateWidget(selected.id, { fontSize: fontSize ?? undefined })} /></EditorField><EditorField label="颜色"><Input aria-label={`颜色 ${selected.title}`} type="color" value={selected.color ?? '#2458d3'} onChange={(event) => updateWidget(selected.id, { color: event.target.value })} /></EditorField></> : null}
        {['line', 'pie'].includes(selected.type) ? <EditorField label="图例"><Switch aria-label={`显示图例 ${selected.title}`} checked={selected.showLegend !== false} onChange={(showLegend) => updateWidget(selected.id, { showLegend })} /></EditorField> : null}
        {['gauge', 'progress'].includes(selected.type) ? <EditorField label="最大值"><InputNumber aria-label={`最大值 ${selected.title}`} min={0.000001} value={selected.maxValue} placeholder="100" onChange={(maxValue) => updateWidget(selected.id, { maxValue: maxValue ?? undefined })} /></EditorField> : null}
      </div>}
      {selected.type !== 'text' && (value.parameters ?? []).length ? <div className="rd-dashboard-bindings"><strong>参数映射</strong>{(value.parameters ?? []).map((parameter) => <label key={parameter.key}><span>{parameter.label || parameter.key}</span><Input aria-label={`查询参数 ${parameter.label || parameter.key}`} value={selected.parameterBindings?.find((binding) => binding.dashboardKey === parameter.key)?.queryKey ?? ''} placeholder="查询参数名" onChange={(event) => setParameterBinding(selected, parameter.key, event.target.value)} /></label>)}</div> : null}
    </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无组件" />}
  </div>
}

export default DashboardEditor
