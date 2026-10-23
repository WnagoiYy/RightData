import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '../../client/node_modules/@playwright/test/index.mjs';

const backend = JSON.parse((await readFile(new URL('../runtime/client-integration-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const nativeSession = JSON.parse((await readFile(new URL('../runtime/client-native-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(backend.address).port, '18003', 'native dashboard must use the isolated backend on port 18003');
assert.equal(nativeSession.port, 9225, 'native dashboard must use the isolated WebView on CDP port 9225');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
const context = browser.contexts()[0];
const page = context.pages().find(item => item.url().includes(':1420')) || context.pages()[0];
if (!page) throw new Error('The isolated native test WebView is unavailable.');

const checks = [];
const createdConfigIds = [];
const secrets = [backend.password];
let databaseId;
let serviceWasEnabled;
let loggedIn = false;

function redact(value) {
  let output = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[redacted]');
  return output;
}

const invoke = (command, request) => page.evaluate(async ({ command, request }) => {
  try {
    return await window.__TAURI_INTERNALS__.invoke(command, request === undefined ? undefined : { request });
  } catch (error) {
    throw new Error(typeof error === 'object' && error ? JSON.stringify({ code: error.code, message: error.message, status: error.status }) : String(error));
  }
}, { command, request });

async function api(method, path, body) {
  const response = await invoke('api_request', {
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(method === 'GET' ? {} : { idempotencyKey: `native-dashboard-${randomUUID()}` }),
  });
  if (response.status >= 400 || response.data?.code !== 'ok') {
    throw new Error(`${method} ${path}: ${response.data?.code || response.status} ${response.data?.message || 'request failed'}`);
  }
  return response.data.data;
}

async function saveConfig(id, kind, name, body) {
  const saved = await api('PUT', `/api/v1/configs/${encodeURIComponent(id)}`, { kind, name, body, version: 0 });
  createdConfigIds.push(id);
  return saved;
}

async function openResource(menuId) {
  await page.evaluate(id => { location.hash = `resource:${id}`; }, menuId);
  await expect(page.locator('.rd-config-dashboard')).toBeVisible({ timeout: 30_000 });
}

try {
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke), { timeout: 20_000 });
  const initialService = await invoke('network_service_get_state');
  serviceWasEnabled = initialService.enabled;
  if (!initialService.enabled) await invoke('network_service_set_enabled', { enabled: true });
  await invoke('transport_configure', { serverUrl: backend.address, discoveryUrl: null, allowPublicRelay: false, rebindInstance: true });
  await invoke('auth_login', { username: backend.username, password: backend.password, remember: false });
  loggedIn = true;

  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const table = `dashboard_rows_${suffix}`;
  const queryId = `native-dashboard-query-${suffix}`;
  const dashboardId = `native-dashboard-${suffix}`;
  const menuId = `native-dashboard-menu-${suffix}`;
  const dashboardName = `原生查询看板 ${suffix}`;
  const databasePassword = `NativeDashboard-${randomUUID()}`;
  secrets.push(databasePassword);

  const database = await api('POST', '/api/v1/data-files', { name: `native-dashboard-${suffix}.duckdb`, password: databasePassword });
  databaseId = database.id;
  await api('POST', `/api/v1/datasets/${encodeURIComponent(databaseId)}/schema:mutate`, {
    action: 'create_table',
    table,
    fields: [
      { name: 'id', dataType: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'city', dataType: 'VARCHAR', nullable: false },
      { name: 'amount', dataType: 'DECIMAL(12,2)', nullable: false },
    ],
  });
  await api('POST', `/api/v1/datasets/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(table)}/records:mutate`, {
    operations: [
      { action: 'insert', values: { id: 1, city: '贵阳', amount: '120.50' } },
      { action: 'insert', values: { id: 2, city: '贵阳', amount: '79.50' } },
      { action: 'insert', values: { id: 3, city: '遵义', amount: '500.00' } },
    ],
  });

  await saveConfig(queryId, 'query', `原生看板查询 ${suffix}`, {
    datasetId: databaseId,
    permissions: [],
    sql: `SELECT id, city, amount FROM "${table}" WHERE city = :area ORDER BY id`,
  });
  await saveConfig(dashboardId, 'dashboard', dashboardName, {
    enabled: true,
    permissions: [],
    definitionIds: [queryId],
    parameters: [{ key: 'city', label: '城市', type: 'text', defaultValue: '贵阳' }],
    theme: 'light',
    refreshSeconds: 0,
    widgets: [
      {
        id: 'sum-gauge', title: '汇总金额', type: 'gauge', definitionId: queryId,
        valueField: 'amount', aggregation: 'sum', valueFormat: 'number', decimalPlaces: 0,
        maxValue: 1000, color: '#2458d3', parameterBindings: [{ dashboardKey: 'city', queryKey: 'area' }],
        layouts: {
          desktop: { x: 0, y: 0, width: 4, height: 3 },
          tablet: { x: 0, y: 0, width: 4, height: 3 },
          mobile: { x: 0, y: 0, width: 4, height: 3 },
        },
      },
      {
        id: 'row-progress', title: '记录进度', type: 'progress', definitionId: queryId,
        aggregation: 'count', valueFormat: 'integer', maxValue: 5, color: '#16a085',
        parameterBindings: [{ dashboardKey: 'city', queryKey: 'area' }],
        layouts: {
          desktop: { x: 4, y: 0, width: 4, height: 3 },
          tablet: { x: 4, y: 0, width: 4, height: 3 },
          mobile: { x: 0, y: 3, width: 4, height: 3 },
        },
      },
      {
        id: 'avg-metric', title: '平均金额', type: 'metric', definitionId: queryId,
        valueField: 'amount', aggregation: 'avg', valueFormat: 'number', decimalPlaces: 0,
        parameterBindings: [{ dashboardKey: 'city', queryKey: 'area' }],
        layouts: {
          desktop: { x: 8, y: 0, width: 4, height: 3 },
          tablet: { x: 0, y: 3, width: 4, height: 3 },
          mobile: { x: 0, y: 6, width: 4, height: 3 },
        },
      },
    ],
  });
  await saveConfig(menuId, 'menu', dashboardName, {
    enabled: true, permissions: [], parentId: '', order: 978, resourceId: dashboardId, resourceKind: 'dashboard',
  });

  await page.reload();
  await expect(page.getByRole('button', { name: backend.username, exact: false })).toBeVisible({ timeout: 30_000 });
  await openResource(menuId);

  const gauge = page.getByRole('meter', { name: '汇总金额' });
  const progress = page.getByRole('progressbar', { name: '记录进度' });
  const average = page.locator('.rd-config-widget[data-widget-id="avg-metric"]');
  await expect(gauge).toHaveAttribute('aria-valuenow', '200', { timeout: 20_000 });
  await expect(progress).toHaveAttribute('aria-valuenow', '2');
  await expect(average).toContainText('100');

  const cityInput = page.locator('.rd-config-param').filter({ hasText: '城市' }).locator('input');
  await cityInput.fill('遵义');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(gauge).toHaveAttribute('aria-valuenow', '500');
  await expect(progress).toHaveAttribute('aria-valuenow', '1');
  await expect(average).toContainText('500');
  checks.push('native dashboard maps the resource parameter into a real SQL query and renders sum, average and count through gauge, metric and progress widgets');

  await page.evaluate(() => { location.hash = 'dashboards'; });
  await expect(page.locator('.rd-config-name-button').filter({ hasText: dashboardName })).toBeVisible({ timeout: 30_000 });
  await page.locator('.rd-config-name-button').filter({ hasText: dashboardName }).click();
  const layoutWidget = page.getByRole('button', { name: '布局组件 汇总金额' });
  await expect(layoutWidget).toBeVisible();
  await layoutWidget.click();
  const heightInput = page.getByLabel('布局高度 汇总金额');
  await heightInput.fill('4');
  await heightInput.blur();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('配置已保存')).toBeVisible();

  const configs = await api('GET', '/api/v1/configs');
  const savedDashboard = configs.items.find(item => item.id === dashboardId);
  assert.ok(savedDashboard, 'saved dashboard is missing from the real configuration API');
  assert.equal(savedDashboard.body.widgets.find(widget => widget.id === 'sum-gauge')?.layouts?.desktop?.height, 4);

  await openResource(menuId);
  await expect(page.getByRole('meter', { name: '汇总金额' })).toHaveAttribute('aria-valuenow', '200', { timeout: 20_000 });
  const ordinaryGauge = page.locator('.rd-config-widget[data-widget-id="sum-gauge"]');
  await expect.poll(() => ordinaryGauge.evaluate(element => element.style.getPropertyValue('--rd-dashboard-desktop-row').trim())).toBe('1 / span 4');
  checks.push('a layout change saved through the native dashboard editor is persisted by the real API and consumed by the ordinary resource renderer');

  const screenshotPath = new URL('../results/client-native-dashboard.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(new URL('../results/client-native-dashboard.json', import.meta.url), JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const description = redact(error);
  const pageText = redact(await page.locator('body').innerText().catch(() => ''));
  await writeFile(new URL('../results/client-native-dashboard.json', import.meta.url), JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: description, pageText }, null, 2));
  throw new Error(description);
} finally {
  for (const id of [...createdConfigIds].reverse()) {
    const list = await api('GET', '/api/v1/configs').catch(() => ({ items: [] }));
    const saved = list.items.find(item => item.id === id);
    if (saved) await api('DELETE', `/api/v1/configs/${encodeURIComponent(id)}?version=${saved.version}`).catch(() => {});
  }
  if (databaseId) await api('DELETE', `/api/v1/data-files/${encodeURIComponent(databaseId)}`).catch(() => {});
  if (loggedIn) await invoke('auth_logout').catch(() => {});
  if (serviceWasEnabled === false) await invoke('network_service_set_enabled', { enabled: false }).catch(() => {});
  await page.reload().catch(() => {});
  await browser.close();
}
