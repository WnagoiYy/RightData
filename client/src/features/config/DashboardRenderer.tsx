import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Alert, Empty, Skeleton, Statistic, Tag, Typography } from 'antd'
import { formatError } from './core'
import { aggregateDashboardRows, dashboardNumericValue, dashboardResultIsPartial, dashboardWidgetRows, mapDashboardWidgetParams, resolveDashboardLayouts } from './dashboard-model'
import { ImageExportButtons, captureElement, parameterDefaults, ResourceParameterBar, ResultTable, type RendererProps } from './resource-ui'
import type { DashboardBody, DashboardViewport, DashboardWidget, QueryResult } from './types'

function formatWidgetValue(value: number | undefined, widget: DashboardWidget): string {
  if (value === undefined) return '--'
  const decimals = Math.max(0, Math.min(6, Math.floor(widget.decimalPlaces ?? 2)))
  if (widget.valueFormat === 'integer') return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
  if (widget.valueFormat === 'percent') return new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)
  if (widget.valueFormat === 'compact') return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: decimals }).format(value)
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: decimals }).format(value)
}

function widgetValue(widget: DashboardWidget, result?: QueryResult): number | undefined {
  if (!result) return undefined
  return aggregateDashboardRows(result.rows, widget.valueField || result.fields[0]?.name, widget.aggregation)
}

function chartValues(widget: DashboardWidget, result: QueryResult | undefined, fallbackLimit: number): Array<{ label: string; value: number }> {
  if (!result?.rows.length) return []
  const category = widget.categoryField || result.fields[0]?.name
  const valueField = widget.valueField || result.fields[1]?.name || result.fields[0]?.name
  const rows = dashboardWidgetRows(widget, result)
  if (widget.aggregation && widget.aggregation !== 'none') {
    const grouped = new Map<string, Array<Record<string, unknown>>>()
    for (const row of rows) {
      const label = String(row[category] ?? '--')
      grouped.set(label, [...(grouped.get(label) ?? []), row])
    }
    return Array.from(grouped, ([label, group]) => ({ label, value: aggregateDashboardRows(group, valueField, widget.aggregation) }))
      .flatMap((item) => item.value === undefined ? [] : [{ label: item.label, value: item.value }])
      .slice(0, widget.limit ?? fallbackLimit)
  }
  return rows.slice(0, widget.limit ?? fallbackLimit).flatMap((row) => {
    const value = dashboardNumericValue(row[valueField])
    return value === undefined ? [] : [{ label: String(row[category] ?? '--'), value }]
  })
}

function BarWidget({ widget, result }: { widget: DashboardWidget; result?: QueryResult }) {
  const values = chartValues(widget, result, 12)
  if (!values.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
  const max = Math.max(...values.map((item) => Math.abs(item.value)), 1)
  return <div className="rd-config-bars">{values.map((item, index) => <div className="rd-config-bar-row" key={`${item.label}-${index}`}><span title={item.label}>{item.label}</span><i><b style={{ width: `${Math.max(2, Math.abs(item.value) / max * 100)}%`, background: widget.color }} /></i><strong>{formatWidgetValue(item.value, widget)}</strong></div>)}</div>
}

function LineWidget({ widget, result }: { widget: DashboardWidget; result?: QueryResult }) {
  const values = chartValues(widget, result, 24)
  if (!values.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
  const width = 600, height = 180, padding = 18
  const minimum = Math.min(...values.map((item) => item.value)), maximum = Math.max(...values.map((item) => item.value))
  const range = maximum - minimum || 1
  const points = values.map((item, index) => ({ ...item, x: values.length === 1 ? width / 2 : padding + index * (width - padding * 2) / (values.length - 1), y: height - padding - (item.value - minimum) / range * (height - padding * 2) }))
  const last = values[values.length - 1]
  return <div className="rd-config-line-chart" style={widget.color ? { color: widget.color } : undefined}>
    <svg role="img" aria-label={`${widget.title || '折线图'}数据走势`} viewBox={`0 0 ${width} ${height}`}>
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="rd-config-chart-axis" />
      <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} />
      {points.map((point, index) => <circle key={`${point.label}-${index}`} cx={point.x} cy={point.y} r="4"><title>{point.label}：{formatWidgetValue(point.value, widget)}</title></circle>)}
    </svg>
    {widget.showLegend !== false ? <div className="rd-config-line-caption"><span>{values[0].label}</span><strong>{formatWidgetValue(last.value, widget)}</strong><span>{last.label}</span></div> : null}
  </div>
}

const pieColors = ['#2458d3', '#16a085', '#e6a23c', '#7c3aed', '#d94f70', '#0f8fa6', '#7a8b28', '#64748b']

function PieWidget({ widget, result }: { widget: DashboardWidget; result?: QueryResult }) {
  const grouped = new Map<string, number>()
  for (const item of chartValues(widget, result, 24)) if (item.value > 0) grouped.set(item.label, (grouped.get(item.label) ?? 0) + item.value)
  const values = Array.from(grouped, ([label, value]) => ({ label, value })).slice(0, widget.limit ?? 8)
  const total = values.reduce((sum, item) => sum + item.value, 0)
  if (!values.length || total <= 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可绘制的正数数据" />
  let offset = 0
  const colorAt = (index: number) => index === 0 && widget.color ? widget.color : pieColors[index % pieColors.length]
  return <div className={`rd-config-pie-chart${widget.showLegend === false ? ' rd-config-pie-chart-no-legend' : ''}`}>
    <svg role="img" aria-label={`${widget.title || '饼图'}占比`} viewBox="0 0 42 42"><circle className="rd-config-pie-track" cx="21" cy="21" r="15.9155" />
      {values.map((item, index) => { const share = item.value / total * 100, dashOffset = -offset; offset += share; return <circle className="rd-config-pie-segment" key={`${item.label}-${index}`} cx="21" cy="21" r="15.9155" pathLength="100" stroke={colorAt(index)} strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={dashOffset}><title>{item.label}：{formatWidgetValue(item.value, widget)}</title></circle> })}
    </svg>
    {widget.showLegend !== false ? <div className="rd-config-chart-legend">{values.map((item, index) => <div key={`${item.label}-${index}`}><i style={{ background: colorAt(index) }} /><span title={item.label}>{item.label}</span><strong>{formatWidgetValue(item.value, widget)}</strong></div>)}</div> : null}
  </div>
}

function GaugeWidget({ widget, result }: { widget: DashboardWidget; result?: QueryResult }) {
  const value = widgetValue(widget, result), maximum = Math.max(0.000001, widget.maxValue ?? (widget.valueFormat === 'percent' ? 1 : 100))
  const percent = Math.max(0, Math.min(100, (value ?? 0) / maximum * 100))
  return <div className="rd-config-gauge" style={{ color: widget.color }}><svg role="meter" aria-label={widget.title || '仪表盘'} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={value} viewBox="0 0 200 118"><path className="rd-config-gauge-track" d="M20 100 A80 80 0 0 1 180 100" pathLength="100" /><path className="rd-config-gauge-value" d="M20 100 A80 80 0 0 1 180 100" pathLength="100" strokeDasharray={`${percent} 100`} /></svg><strong style={{ fontSize: widget.fontSize }}>{formatWidgetValue(value, widget)}</strong></div>
}

function ProgressWidget({ widget, result }: { widget: DashboardWidget; result?: QueryResult }) {
  const value = widgetValue(widget, result), maximum = Math.max(0.000001, widget.maxValue ?? (widget.valueFormat === 'percent' ? 1 : 100))
  const percent = Math.max(0, Math.min(100, (value ?? 0) / maximum * 100))
  return <div className="rd-config-progress" role="progressbar" aria-label={widget.title || '进度'} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={value}><div><i style={{ width: `${percent}%`, background: widget.color }} /></div><strong style={{ color: widget.color, fontSize: widget.fontSize }}>{formatWidgetValue(value, widget)}</strong></div>
}

function DashboardWidgetView({ widget, result, loading, style }: { widget: DashboardWidget; result?: QueryResult; loading: boolean; style: CSSProperties }) {
  const tableResult = result ? { ...result, rows: dashboardWidgetRows(widget, result) } : undefined
  const partial = dashboardResultIsPartial(result) ? `当前组件仅基于已返回的 ${result!.rows.length} 条记录，查询总数 ${result!.total} 条` : undefined
  const numericField = widget.valueField || result?.fields[0]?.name
  const unsafeNumeric = widget.type !== 'table' && widget.type !== 'text' && widget.aggregation !== 'count' && !!result?.rows.some((row) => {
    const raw = row[numericField ?? '']
    return raw !== null && raw !== undefined && raw !== '' && dashboardNumericValue(raw) === undefined
  })
  const aggregationLabel = widget.aggregation && widget.aggregation !== 'none' ? widget.aggregation.toUpperCase() : undefined
  return <section className={`rd-config-widget${widget.gridSpan === 2 ? ' rd-config-widget-span-2' : ''}`} data-widget-id={widget.id} style={style}>
    <header><strong>{widget.title || '未命名组件'}</strong>{aggregationLabel ? <Tag bordered={false}>{aggregationLabel}</Tag> : widget.definitionId ? <Tag bordered={false}>查询</Tag> : null}</header>
    <div className="rd-config-widget-body">{partial ? <div className="rd-config-widget-warning" role="status">{partial}</div> : null}{unsafeNumeric ? <div className="rd-config-widget-warning" role="status">部分数值超出浏览器安全精度，未参与计算</div> : null}{loading ? <Skeleton active paragraph={{ rows: 3 }} title={false} /> : widget.type === 'text' ? <Typography.Paragraph style={{ color: widget.color, fontSize: widget.fontSize }}>{widget.text || '文本组件'}</Typography.Paragraph> : widget.type === 'metric' ? <Statistic value={widgetValue(widget, result) ?? 0} valueStyle={{ color: widget.color, fontSize: widget.fontSize }} formatter={() => formatWidgetValue(widgetValue(widget, result), widget)} /> : widget.type === 'bar' ? <BarWidget widget={widget} result={result} /> : widget.type === 'line' ? <LineWidget widget={widget} result={result} /> : widget.type === 'pie' ? <PieWidget widget={widget} result={result} /> : widget.type === 'gauge' ? <GaugeWidget widget={widget} result={result} /> : widget.type === 'progress' ? <ProgressWidget widget={widget} result={result} /> : <ResultTable result={tableResult} />}</div>
  </section>
}

type GridStyle = CSSProperties & Record<`--rd-dashboard-${DashboardViewport}-${'column' | 'row'}`, string>

function widgetGridStyle(widgetId: string, layouts: Record<DashboardViewport, Record<string, { x: number; y: number; width: number; height: number }>>): GridStyle {
  const style = {} as GridStyle
  for (const viewport of ['desktop', 'tablet', 'mobile'] as const) {
    const layout = layouts[viewport][widgetId]
    style[`--rd-dashboard-${viewport}-column`] = `${layout.x + 1} / span ${layout.width}`
    style[`--rd-dashboard-${viewport}-row`] = `${layout.y + 1} / span ${layout.height}`
  }
  return style
}

export function DashboardRenderer({ resource, body, params, onParamsChange, execute }: RendererProps & { body: DashboardBody }) {
  const [results, setResults] = useState<Record<string, QueryResult>>({}), [querying, setQuerying] = useState(false), [error, setError] = useState('')
  const initialQuery = useRef(false), querySequence = useRef(0), exportSurface = useRef<HTMLDivElement>(null)
  const paramsKey = JSON.stringify(params), previousParamsKey = useRef(paramsKey), widgets = body.widgets ?? []
  const layouts = useMemo(() => ({ desktop: resolveDashboardLayouts(widgets, 'desktop'), tablet: resolveDashboardLayouts(widgets, 'tablet'), mobile: resolveDashboardLayouts(widgets, 'mobile') }), [widgets])
  const query = useCallback(async () => {
    const queryWidgets = widgets.filter((widget) => widget.definitionId), sequence = ++querySequence.current
    setQuerying(true); setError('')
    try { const next = await Promise.all(queryWidgets.map(async (widget) => [widget.id, await execute(widget.definitionId!, mapDashboardWidgetParams(widget, params))] as const)); if (sequence === querySequence.current) setResults(Object.fromEntries(next)) }
    catch (cause) { if (sequence === querySequence.current) setError(formatError(cause, '看板查询失败')) }
    finally { if (sequence === querySequence.current) setQuerying(false) }
  }, [execute, params, widgets])
  useEffect(() => { if (previousParamsKey.current !== paramsKey) { previousParamsKey.current = paramsKey; querySequence.current += 1; setResults({}); setError(''); setQuerying(false) } }, [paramsKey])
  useEffect(() => { const parameters = body.parameters ?? []; if (parameters.length && Object.keys(params).length === 0) { onParamsChange(parameterDefaults(parameters)); return } if (!widgets.some((widget) => widget.definitionId) || initialQuery.current) return; initialQuery.current = true; void query() }, [body.parameters, onParamsChange, params, query, widgets])
  useEffect(() => { if (!body.refreshSeconds) return; const timer = window.setInterval(() => void query(), body.refreshSeconds * 1000); return () => window.clearInterval(timer) }, [body.refreshSeconds, query])
  return <div className={`rd-config-runtime rd-config-dashboard rd-config-dashboard-${body.theme ?? 'light'}`}><ResourceParameterBar parameters={body.parameters ?? []} value={params} onChange={onParamsChange} onSubmit={() => void query()} loading={querying} />{error ? <Alert type="error" showIcon message={error} /> : null}<div className="rd-config-export-actions"><ImageExportButtons name={resource.name} capture={(format) => captureElement(exportSurface.current, format, body.theme === 'dark' ? '#111827' : '#f5f7fb')} /></div><div ref={exportSurface} className="rd-config-dashboard-export-surface">{widgets.length ? <div className="rd-config-widget-grid">{widgets.map((widget) => <DashboardWidgetView key={widget.id} widget={widget} result={results[widget.id]} loading={querying && !results[widget.id]} style={widgetGridStyle(widget.id, layouts)} />)}</div> : <Empty description="尚未添加看板组件" />}</div></div>
}
