import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

let control;

test.beforeEach(async ({ page }) => {
  control = await installNativeMock(page);
  control.rows = control.rows.map((row) => ({ ...row, 占比: '0.1234' }));
  const dashboard = control.configs.get('daily-board');
  control.configs.set('daily-board', {
    ...dashboard,
    body: {
      ...dashboard.body,
      definitionIds: ['daily-query'],
      widgets: [
        { id: 'metric', title: '占比指标', type: 'metric', definitionId: 'daily-query', valueField: '占比', valueFormat: 'percent', decimalPlaces: 1 },
        { id: 'line', title: '金额趋势', type: 'line', definitionId: 'daily-query', categoryField: '地市', valueField: '金额', valueFormat: 'number', decimalPlaces: 0 },
        { id: 'pie', title: '产品占比', type: 'pie', definitionId: 'daily-query', categoryField: '产品', valueField: '金额', valueFormat: 'compact', decimalPlaces: 1 },
      ],
    },
  });
});

async function openDashboard(page) {
  await page.goto('/#dashboards');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益运营看板' }).click();
  await expect(page.locator('.rd-config-widget[data-widget-id="metric"]')).toContainText('12.3%');
}

test('看板渲染折线、饼图和可配置数值格式', async ({ page }) => {
  await openDashboard(page);
  await expect(page.locator('.rd-config-line-chart polyline')).toBeVisible();
  await expect(page.locator('.rd-config-line-chart circle')).toHaveCount(4);
  await expect(page.locator('.rd-config-pie-segment')).toHaveCount(3);
  await expect(page.locator('.rd-config-chart-legend')).toContainText('权益产品 A');

  const decimals = page.getByLabel('小数位数 占比指标');
  await decimals.fill('2');
  await expect(page.locator('.rd-config-widget[data-widget-id="metric"]')).toContainText('12.34%');
});

test('看板组件可调整宽度和顺序并按当前顺序保存', async ({ page }) => {
  await openDashboard(page);

  const width = page.getByLabel('组件宽度 占比指标');
  await width.click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '通栏' }).click();
  await expect(page.locator('.rd-config-widget[data-widget-id="metric"]')).toHaveClass(/rd-config-widget-span-2/);

  await page.getByRole('button', { name: '下移组件 占比指标' }).click();
  await expect.poll(async () => page.locator('.rd-config-preview .rd-config-widget > header strong').allTextContents()).toEqual(['金额趋势', '占比指标', '产品占比']);

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => control.requests.filter((request) => request.command === 'api_request' && request.method === 'PUT').length).toBe(1);
  const saved = control.requests.find((request) => request.command === 'api_request' && request.method === 'PUT');
  expect(saved.body.body.widgets.map((widget) => widget.id)).toEqual(['line', 'metric', 'pie']);
  expect(saved.body.body.widgets.find((widget) => widget.id === 'metric').gridSpan).toBe(2);
});

test('仪表盘和进度组件汇总已返回数据、映射参数并支持键盘布局', async ({ page }) => {
  control.queryTotal = 12;
  const dashboard = control.configs.get('daily-board');
  control.configs.set('daily-board', {
    ...dashboard,
    body: {
      ...dashboard.body,
      parameters: [{ key: 'city', label: '地市', type: 'text', defaultValue: '贵阳' }],
      widgets: [
        { id: 'gauge', title: '总金额', type: 'gauge', definitionId: 'daily-query', valueField: '金额', aggregation: 'sum', valueFormat: 'integer', maxValue: 6000, color: '#8b5cf6', parameterBindings: [{ dashboardKey: 'city', queryKey: 'area' }] },
        { id: 'progress', title: '返回进度', type: 'progress', definitionId: 'daily-query', aggregation: 'count', valueFormat: 'integer', maxValue: 12 },
      ],
    },
  });

  await page.goto('/#dashboards');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益运营看板' }).click();
  await expect(page.getByRole('meter', { name: '总金额' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '返回进度' })).toBeVisible();
  await expect(page.locator('.rd-config-widget[data-widget-id="gauge"]')).toContainText('5,351');
  await expect(page.locator('.rd-config-widget[data-widget-id="progress"]')).toContainText('4');
  await expect(page.locator('.rd-config-widget-warning').first()).toContainText('仅基于已返回的 4 条记录，查询总数 12 条');
  await expect.poll(() => control.requests.some((request) => request.path === '/api/v1/resources/preview' && request.body?.params?.area === '贵阳')).toBe(true);

  const layoutWidget = page.getByRole('button', { name: '布局组件 总金额' });
  await layoutWidget.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => control.requests.filter((request) => request.command === 'api_request' && request.method === 'PUT').length).toBe(1);
  const saved = control.requests.find((request) => request.command === 'api_request' && request.method === 'PUT');
  expect(saved.body.body.widgets.find((widget) => widget.id === 'gauge').layouts.desktop.y).toBe(1);
});
