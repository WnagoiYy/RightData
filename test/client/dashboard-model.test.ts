import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateDashboardRows,
  dashboardNumericValue,
  dashboardLayoutsOverlap,
  dashboardResultIsPartial,
  dashboardWidgetRows,
  mapDashboardWidgetParams,
  resolveDashboardLayouts,
  updateDashboardWidgetLayout,
} from '../../client/src/features/config/dashboard-model'
import type { DashboardWidget, QueryResult } from '../../client/src/features/config/types'

test('看板布局兼容 gridSpan 并在移动后消除碰撞', () => {
  const widgets: DashboardWidget[] = [
    { id: 'a', title: 'A', type: 'metric', gridSpan: 1 },
    { id: 'b', title: 'B', type: 'metric', gridSpan: 2 },
  ]
  const initial = resolveDashboardLayouts(widgets, 'desktop')
  assert.equal(initial.a.width, 6)
  assert.equal(initial.b.width, 12)
  assert.equal(initial.b.y, 3)

  const moved = updateDashboardWidgetLayout(widgets, 'b', 'desktop', { x: 0, y: 0, width: 6, height: 2 })
  const resolved = resolveDashboardLayouts(moved, 'desktop')
  assert.equal(dashboardLayoutsOverlap(resolved.a, resolved.b), false)
})

test('组件参数映射、排序限制与汇总只处理安全数值', () => {
  const widget: DashboardWidget = {
    id: 'amount', title: '金额', type: 'metric', valueField: '金额', aggregation: 'sum',
    sortField: '金额', sortDirection: 'desc', limit: 2,
    parameterBindings: [{ dashboardKey: 'city', queryKey: 'area' }],
  }
  const result: QueryResult = {
    fields: [{ name: '金额' }], total: 5,
    rows: [{ 金额: '8.5' }, { 金额: null }, { 金额: '10' }, { 金额: '9007199254740993' }],
  }
  assert.deepEqual(mapDashboardWidgetParams(widget, { city: '贵阳', ignored: true }), { area: '贵阳' })
  assert.deepEqual(dashboardWidgetRows(widget, result).map((row) => row.金额), ['10', '8.5'])
  assert.equal(aggregateDashboardRows(result.rows, '金额', 'sum'), 18.5)
  assert.equal(dashboardNumericValue('9007199254740993'), undefined)
  assert.equal(dashboardResultIsPartial(result), true)
})
