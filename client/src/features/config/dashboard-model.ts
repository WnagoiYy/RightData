import type {
  DashboardAggregation,
  DashboardViewport,
  DashboardWidget,
  DashboardWidgetLayout,
  QueryResult,
} from './types'

export const DASHBOARD_COLUMNS: Record<DashboardViewport, number> = {
  desktop: 12,
  tablet: 8,
  mobile: 4,
}

const DEFAULT_HEIGHT = 3

function integer(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value as number) : fallback
}

export function clampDashboardLayout(layout: Partial<DashboardWidgetLayout>, viewport: DashboardViewport): DashboardWidgetLayout {
  const columns = DASHBOARD_COLUMNS[viewport]
  const width = Math.max(1, Math.min(columns, integer(layout.width, columns)))
  return {
    x: Math.max(0, Math.min(columns - width, integer(layout.x, 0))),
    y: Math.max(0, integer(layout.y, 0)),
    width,
    height: Math.max(1, Math.min(12, integer(layout.height, DEFAULT_HEIGHT))),
  }
}

export function dashboardLayoutsOverlap(left: DashboardWidgetLayout, right: DashboardWidgetLayout): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
}

function compatibleWidth(widget: DashboardWidget, viewport: DashboardViewport): number {
  const columns = DASHBOARD_COLUMNS[viewport]
  if (viewport === 'mobile') return columns
  return widget.gridSpan === 2 ? columns : Math.ceil(columns / 2)
}

function firstOpenLayout(candidate: DashboardWidgetLayout, occupied: DashboardWidgetLayout[], viewport: DashboardViewport): DashboardWidgetLayout {
  const columns = DASHBOARD_COLUMNS[viewport]
  let next = clampDashboardLayout(candidate, viewport)
  let attempts = 0
  while (occupied.some((layout) => dashboardLayoutsOverlap(next, layout)) && attempts < 1000) {
    const shiftedX = next.x + 1
    next = shiftedX + next.width <= columns ? { ...next, x: shiftedX } : { ...next, x: 0, y: next.y + 1 }
    attempts += 1
  }
  return next
}

export function resolveDashboardLayouts(widgets: DashboardWidget[], viewport: DashboardViewport): Record<string, DashboardWidgetLayout> {
  const resolved: Record<string, DashboardWidgetLayout> = {}
  const occupied: DashboardWidgetLayout[] = []
  for (const widget of widgets) {
    const stored = widget.layouts?.[viewport]
    const candidate = stored
      ? clampDashboardLayout(stored, viewport)
      : clampDashboardLayout({ x: 0, y: 0, width: compatibleWidth(widget, viewport), height: DEFAULT_HEIGHT }, viewport)
    const placed = firstOpenLayout(candidate, occupied, viewport)
    resolved[widget.id] = placed
    occupied.push(placed)
  }
  return resolved
}

export function placeDashboardWidget(
  widgets: DashboardWidget[],
  widgetId: string,
  viewport: DashboardViewport,
  requested: Partial<DashboardWidgetLayout>,
): DashboardWidgetLayout {
  const layouts = resolveDashboardLayouts(widgets, viewport)
  const current = layouts[widgetId] ?? clampDashboardLayout({}, viewport)
  const occupied = Object.entries(layouts).filter(([id]) => id !== widgetId).map(([, layout]) => layout)
  return firstOpenLayout(clampDashboardLayout({ ...current, ...requested }, viewport), occupied, viewport)
}

export function updateDashboardWidgetLayout(
  widgets: DashboardWidget[],
  widgetId: string,
  viewport: DashboardViewport,
  requested: Partial<DashboardWidgetLayout>,
): DashboardWidget[] {
  const placed = placeDashboardWidget(widgets, widgetId, viewport, requested)
  return widgets.map((widget) => widget.id === widgetId
    ? { ...widget, layouts: { ...widget.layouts, [viewport]: placed } }
    : widget)
}

export function mapDashboardWidgetParams(widget: DashboardWidget, params: Record<string, unknown>): Record<string, unknown> {
  const bindings = (widget.parameterBindings ?? []).filter((binding) => binding.dashboardKey && binding.queryKey)
  if (!bindings.length) return params
  return Object.fromEntries(bindings
    .filter((binding) => Object.prototype.hasOwnProperty.call(params, binding.dashboardKey))
    .map((binding) => [binding.queryKey, params[binding.dashboardKey]]))
}

export function dashboardNumericValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return undefined
    if (/^[+-]?\d+$/.test(text)) {
      try {
        const exact = BigInt(text)
        if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) return undefined
      } catch { return undefined }
    } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
      const significantDigits = text.replace(/^[+-]?0*|[.eE+-]/g, '').replace(/0+$/, '').length
      if (significantDigits > 15) return undefined
    }
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return undefined
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) return undefined
  return parsed
}

export function aggregateDashboardRows(rows: Array<Record<string, unknown>>, field: string | undefined, aggregation: DashboardAggregation | undefined): number | undefined {
  if (aggregation === 'count') return rows.length
  const values = rows.flatMap((row) => {
    const value = dashboardNumericValue(row[field ?? ''])
    return value === undefined ? [] : [value]
  })
  if (!values.length) return undefined
  if (aggregation === 'sum') return values.reduce((sum, value) => sum + value, 0)
  if (aggregation === 'avg') return values.reduce((sum, value) => sum + value, 0) / values.length
  if (aggregation === 'min') return Math.min(...values)
  if (aggregation === 'max') return Math.max(...values)
  return values[0]
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function compare(left: unknown, right: unknown): number {
  const leftNumber = dashboardNumericValue(left)
  const rightNumber = dashboardNumericValue(right)
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
  return collator.compare(String(left ?? ''), String(right ?? ''))
}

export function dashboardWidgetRows(widget: DashboardWidget, result?: QueryResult, fallbackLimit?: number): Array<Record<string, unknown>> {
  if (!result) return []
  const rows = [...result.rows]
  if (widget.sortField) {
    const direction = widget.sortDirection === 'desc' ? -1 : 1
    rows.sort((left, right) => {
      const leftValue = left[widget.sortField!], rightValue = right[widget.sortField!]
      const leftNumber = dashboardNumericValue(leftValue), rightNumber = dashboardNumericValue(rightValue)
      if (leftNumber !== undefined && rightNumber === undefined) return -1
      if (leftNumber === undefined && rightNumber !== undefined) return 1
      return compare(leftValue, rightValue) * direction
    })
  }
  const configuredLimit = widget.limit && widget.limit > 0 ? Math.floor(widget.limit) : fallbackLimit
  return configuredLimit ? rows.slice(0, configuredLimit) : rows
}

export function dashboardResultIsPartial(result?: QueryResult): boolean {
  if (!result) return false
  const explicit = (result as QueryResult & { truncated?: boolean }).truncated === true
  return explicit || result.total > result.rows.length
}
