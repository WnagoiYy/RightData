import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '../../client/node_modules/@playwright/test/index.mjs';

const backend = JSON.parse((await readFile(new URL('../runtime/client-integration-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const nativeSession = JSON.parse((await readFile(new URL('../runtime/client-native-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(backend.address).port, '18003', 'native report must use the isolated backend on port 18003');
assert.equal(nativeSession.port, 9225, 'native report must use the isolated WebView on CDP port 9225');

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

function canonicalDecimal(value) {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return String(value);
  const integer = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  const sign = match[1] === '-' && (integer !== '0' || fraction) ? '-' : '';
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
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
    ...(method === 'GET' ? {} : { idempotencyKey: `native-report-${randomUUID()}` }),
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

async function queryDefinition(definitionId, params = {}) {
  return api('POST', `/api/v1/configs/${encodeURIComponent(definitionId)}/execute`, { params });
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
  const table = `report_rows_${suffix}`;
  const mainQueryId = `native-report-query-${suffix}`;
  const detailQueryId = `native-report-detail-query-${suffix}`;
  const mainReportId = `native-report-${suffix}`;
  const detailReportId = `native-report-detail-${suffix}`;
  const mainMenuId = `native-report-menu-${suffix}`;
  const detailMenuId = `native-report-detail-menu-${suffix}`;
  const databasePassword = `NativeReport-${randomUUID()}`;
  secrets.push(databasePassword);

  const database = await api('POST', '/api/v1/data-files', { name: `native-report-${suffix}.duckdb`, password: databasePassword });
  databaseId = database.id;
  await api('POST', `/api/v1/datasets/${encodeURIComponent(databaseId)}/schema:mutate`, {
    action: 'create_table',
    table,
    fields: [
      { name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true },
      { name: 'city', dataType: 'VARCHAR', nullable: false },
      { name: 'product', dataType: 'VARCHAR', nullable: true },
      { name: 'amount', dataType: 'DECIMAL(30,2)', nullable: true },
    ],
  });
  await api('POST', `/api/v1/datasets/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(table)}/records:mutate`, {
    operations: [
      { action: 'insert', values: { id: '9007199254740993', city: '贵阳', product: '权益产品 A', amount: '123456789012345678.90' } },
      { action: 'insert', values: { id: '9007199254740994', city: '遵义', product: '权益产品 B', amount: '0.10' } },
      { action: 'insert', values: { id: '9007199254740995', city: '毕节', product: '权益产品 C', amount: '0.20' } },
      { action: 'insert', values: { id: '9007199254740996', city: '六盘水', product: null, amount: null } },
    ],
  });

  await saveConfig(mainQueryId, 'query', `原生报表查询 ${suffix}`, {
    datasetId: databaseId,
    permissions: [],
    query: { datasetId: databaseId, table, fields: ['id', 'city', 'product', 'amount'], orderBy: [{ field: 'id', direction: 'ASC' }], limit: 100 },
  });
  await saveConfig(detailQueryId, 'query', `原生钻取查询 ${suffix}`, {
    datasetId: databaseId,
    permissions: [],
    sql: `SELECT id, city, product, amount FROM "${table}" WHERE id = :selectedId`,
  });
  await saveConfig(detailReportId, 'report', `原生钻取详情 ${suffix}`, {
    enabled: true,
    permissions: [],
    definitionIds: [detailQueryId],
    primaryDefinitionId: detailQueryId,
    parameters: [{ key: 'recordId', label: '记录编号', type: 'text' }],
    parameterBindings: [{ parameterKey: 'recordId', queryParameterKey: 'selectedId' }],
    columns: [
      { key: 'id', title: '钻取编号', visible: true },
      { key: 'city', title: '钻取地市', visible: true },
      { key: 'product', title: '钻取产品', visible: true },
      { key: 'amount', title: '钻取金额', visible: true, format: 'number', decimals: 2, unit: '元' },
    ],
    pageSize: 20,
  });
  await saveConfig(mainReportId, 'report', `原生精确报表 ${suffix}`, {
    enabled: true,
    permissions: [],
    definitionIds: [mainQueryId],
    primaryDefinitionId: mainQueryId,
    parameters: [],
    columns: [
      { key: 'id', title: '编号', visible: false },
      { key: 'city', title: '地市', visible: true },
      { key: 'product', title: '产品', visible: true },
      { key: 'amount', title: '金额', visible: true, align: 'right', format: 'number', decimals: 2, unit: '元', summary: 'avg' },
    ],
    defaultSorts: [{ key: 'amount', direction: 'descend' }],
    drilldowns: [{ triggerField: 'city', targetResourceId: detailReportId, parameterMappings: [{ sourceField: 'id', targetParameter: 'recordId' }] }],
    maintenance: {
      definitionId: mainQueryId,
      datasetId: databaseId,
      table,
      keyFields: ['id'],
      writableFields: ['id', 'city', 'product', 'amount'],
      allowInsert: true,
      allowUpdate: true,
      allowDelete: true,
    },
    pageSize: 20,
  });
  await saveConfig(detailMenuId, 'menu', `原生钻取详情 ${suffix}`, {
    enabled: true, permissions: [], parentId: '', order: 980, resourceId: detailReportId, resourceKind: 'report',
  });
  await saveConfig(mainMenuId, 'menu', `原生精确报表 ${suffix}`, {
    enabled: true, permissions: [], parentId: '', order: 979, resourceId: mainReportId, resourceKind: 'report',
  });

  await page.reload();
  await expect(page.getByRole('button', { name: backend.username, exact: false })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(menuId => { location.hash = `resource:${menuId}`; }, mainMenuId);
  const tableView = page.locator('.rd-config-data-surface table').first();
  await expect(tableView.getByRole('columnheader', { name: '编号' })).toHaveCount(0);
  await expect(tableView.getByText('123,456,789,012,345,678.90元')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('全量平均：41,152,263,004,115,226.40元')).toBeVisible();
  await expect(tableView.locator('tbody tr:not(.ant-table-measure-row)').first()).toContainText('贵阳');
  checks.push('native ordinary report preserves precise values, visible columns, full-result average and default ordering');

  await tableView.getByRole('button', { name: '编辑' }).first().click();
  const editDialog = page.getByRole('dialog', { name: '编辑记录' });
  await editDialog.getByLabel('产品').fill('权益产品 A（已更新）');
  await editDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('更新 1 条记录')).toBeVisible();
  let rows = (await queryDefinition(mainQueryId)).rows;
  assert.equal(rows.find(row => row.id === '9007199254740993')?.product, '权益产品 A（已更新）');

  await page.getByRole('button', { name: '新增记录' }).click();
  const insertDialog = page.getByRole('dialog', { name: '新增记录' });
  await insertDialog.getByLabel('编号').fill('9007199254740997');
  await insertDialog.getByLabel('地市').fill('安顺');
  await insertDialog.getByLabel('产品').fill('权益产品 D');
  await insertDialog.getByLabel('金额').fill('42.50');
  await insertDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('新增 1 条记录')).toBeVisible();
  rows = (await queryDefinition(mainQueryId)).rows;
  const inserted = rows.find(row => row.id === '9007199254740997');
  assert.deepEqual({ ...inserted, amount: undefined }, { id: '9007199254740997', city: '安顺', product: '权益产品 D', amount: undefined });
  assert.equal(canonicalDecimal(inserted.amount), canonicalDecimal('42.50'));

  const insertedRow = tableView.getByRole('row').filter({ hasText: '安顺' });
  await insertedRow.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await expect(page.getByText('删除 1 条记录')).toBeVisible();
  rows = (await queryDefinition(mainQueryId)).rows;
  assert.equal(rows.some(row => row.id === '9007199254740997'), false);
  checks.push('native report insert, update and primary-key-filtered delete are confirmed by the server query API');

  await tableView.getByRole('button', { name: '贵阳' }).click();
  await expect(page.getByRole('columnheader', { name: '钻取编号' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '9007199254740993' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '贵阳' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '遵义' })).toHaveCount(0);
  const detail = await queryDefinition(detailQueryId, { selectedId: '9007199254740993' });
  assert.equal(detail.total, 1);
  assert.equal(detail.rows[0]?.city, '贵阳');
  checks.push('row drilldown maps the precise BIGINT key into the target report parameter and executes its authorized resource query');

  await page.screenshot({ path: new URL('../results/client-native-report.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await writeFile(new URL('../results/client-native-report.json', import.meta.url), JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const description = redact(error);
  const pageText = redact(await page.locator('body').innerText().catch(() => ''));
  await writeFile(new URL('../results/client-native-report.json', import.meta.url), JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: description, pageText }, null, 2));
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
