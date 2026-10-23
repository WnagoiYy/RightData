import { readFile } from 'node:fs/promises';
import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';

const enabled = process.env.RIGHTDATA_REAL_INTEGRATION === '1';
const sessionFile = new URL('../runtime/client-integration-session.json', import.meta.url);

class IntegrationApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function rawRequest(base, token, path, options = {}) {
  const headers = new Headers({ accept: 'application/json' });
  for (const [name, value] of Object.entries(options.headers || {})) headers.set(name, value);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function request(base, token, path, options) {
  const response = await rawRequest(base, token, path, options);
  if (response.status >= 400 || response.data?.code !== 'ok') {
    throw new IntegrationApiError(response.status, response.data?.code, response.data?.message);
  }
  return response.data.data;
}

function operationKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('真实后端配置经菜单授权查看，停用后客户端清除旧数据', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!enabled, '设置 RIGHTDATA_REAL_INTEGRATION=1 后运行本机隔离实例集成测试');

  const runtime = JSON.parse(await readFile(sessionFile, 'utf8'));
  const base = runtime.address || 'http://127.0.0.1:18003';
  const host = new URL(base).hostname;
  expect(['127.0.0.1', 'localhost', '::1', '[::1]']).toContain(host);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ids = {
    query: `config-query-${suffix}`,
    report: `config-report-${suffix}`,
    menu: `config-menu-${suffix}`,
  };
  const viewerCredentials = { username: 'config-integration-viewer', password: 'RightDataConfigViewer!2026' };
  let adminToken = '';
  let viewerToken = '';
  let viewer;
  let dataFile;
  let connection;
  const savedConfigs = new Map();

  const saveConfig = async (id, kind, name, body, version = 0) => {
    const idempotencyKey = operationKey(`config-${id}`);
    const saved = await request(base, adminToken, `/api/v1/configs/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'idempotency-key': idempotencyKey },
      body: { kind, name, body, version, idempotencyKey },
    });
    savedConfigs.set(id, saved);
    return saved;
  };

  try {
    const adminSession = await request(base, '', '/api/v1/auth/login', {
      method: 'POST',
      body: { username: runtime.username, password: runtime.password, remember: false },
    });
    adminToken = adminSession.accessToken;

    dataFile = await request(base, adminToken, '/api/v1/data-files', {
      method: 'POST',
      body: { name: `config-integration-${suffix}.duckdb`, password: 'RightDataConfigDb!2026' },
    });
    connection = await request(base, adminToken, '/api/v1/connections', {
      method: 'POST',
      body: { fileId: dataFile.id, name: `配置集成 ${suffix}` },
    });
    const schemaKey = operationKey('schema');
    await request(base, adminToken, `/api/v1/datasets/${encodeURIComponent(dataFile.id)}/schema:mutate`, {
      method: 'POST',
      headers: { 'idempotency-key': schemaKey },
      body: {
        idempotencyKey: schemaKey,
        action: 'create_table',
        table: 'config_rows',
        fields: [
          { name: 'label', dataType: 'VARCHAR', nullable: false },
          { name: 'amount', dataType: 'INTEGER', nullable: false },
        ],
      },
    });
    const recordsKey = operationKey('records');
    await request(base, adminToken, `/api/v1/datasets/${encodeURIComponent(dataFile.id)}/tables/config_rows/records:mutate`, {
      method: 'POST',
      headers: { 'idempotency-key': recordsKey },
      body: { idempotencyKey: recordsKey, operations: [{ action: 'insert', values: { label: '真实后端记录', amount: 37 } }] },
    });

    await saveConfig(ids.query, 'query', '集成查询定义', {
      datasetId: dataFile.id,
      query: { table: 'config_rows', fields: ['label', 'amount'], limit: 20 },
      permissions: [],
    });
    const report = await saveConfig(ids.report, 'report', '集成资源报表', {
      enabled: true,
      permissions: [],
      definitionIds: [ids.query],
      primaryDefinitionId: ids.query,
      parameters: [],
      columns: [{ key: 'label', title: '名称' }, { key: 'amount', title: '数值', format: 'number' }],
    });
    await saveConfig(ids.menu, 'menu', '集成资源入口', {
      enabled: true,
      permissions: [],
      parentId: '',
      order: 1,
      resourceId: ids.report,
      resourceKind: 'report',
    });

    const users = await request(base, adminToken, '/api/v1/users');
    viewer = users.items.find(item => item.username === viewerCredentials.username);
    if (!viewer) {
      viewer = await request(base, adminToken, '/api/v1/users', {
        method: 'POST',
        body: { ...viewerCredentials, permissions: ['resources.read', 'data.read'] },
      });
    }
    await request(base, adminToken, `/api/v1/users/${encodeURIComponent(viewer.id)}`, {
      method: 'PUT',
      body: { permissions: ['resources.read', 'data.read'], disabled: false },
    });
    await request(base, adminToken, `/api/v1/users/${encodeURIComponent(viewer.id)}/grants`, {
      method: 'PUT',
      body: { datasetId: dataFile.id, table: 'config_rows', operations: ['read'], columns: ['*'], rowFilter: null },
    });

    const viewerSession = await request(base, '', '/api/v1/auth/login', {
      method: 'POST',
      body: { ...viewerCredentials, remember: false },
    });
    viewerToken = viewerSession.accessToken;

    const menus = await request(base, viewerToken, '/api/v1/menus');
    expect(menus.items.some(item => item.id === ids.menu && item.resourceId === ids.report)).toBeTruthy();
    const resource = await request(base, viewerToken, `/api/v1/resources/${encodeURIComponent(ids.report)}`);
    expect(resource.id).toBe(ids.report);
    const result = await request(base, viewerToken, `/api/v1/resources/${encodeURIComponent(ids.report)}/execute`, {
      method: 'POST',
      body: { definitionId: ids.query, params: {} },
    });
    expect(result.rows).toContainEqual({ label: '真实后端记录', amount: 37 });

    await page.exposeFunction('__rightdataRealNative', async (command, args = {}) => {
      if (command === 'transport_get_state') return { ok: true, value: { settings: { serverUrl: base, allowPublicRelay: false }, connection: { mode: 'direct', ready: true }, session: { authenticated: true, user: viewer, remember: false } } };
      if (command === 'transport_probe') return { ok: true, value: { mode: 'direct', ready: true } };
      if (command === 'auth_restore') return { ok: true, value: { authenticated: true, user: viewer } };
      if (command !== 'api_request') return { ok: false, error: { message: `未支持的原生命令 ${command}` } };
      const input = args.request || {};
      const response = await rawRequest(base, viewerToken, input.path, { method: input.method, body: input.body });
      return { ok: true, value: { status: response.status, headers: {}, data: response.data } };
    });
    await page.addInitScript(() => {
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        const response = await window.__rightdataRealNative(command, args);
        if (!response.ok) throw response.error;
        return response.value;
      } };
    });

    await page.goto(`/#resource:${encodeURIComponent(ids.menu)}`);
    await expect(page.getByRole('cell', { name: '真实后端记录' })).toBeVisible();

    const disabledReport = await saveConfig(ids.report, 'report', report.name, { ...report.body, enabled: false }, report.version);
    expect(disabledReport.version).toBe(report.version + 1);
    await page.getByRole('button', { name: '刷新数据' }).click();
    await expect(page.getByRole('cell', { name: '真实后端记录' })).not.toBeVisible();
    await expect(page.getByText('没有资源访问权限')).toBeVisible();

    const menusAfterDisable = await request(base, viewerToken, '/api/v1/menus');
    expect(menusAfterDisable.items.some(item => item.id === ids.menu)).toBeFalsy();
    const denied = await rawRequest(base, viewerToken, `/api/v1/resources/${encodeURIComponent(ids.report)}`);
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe('resource_forbidden');
  } finally {
    if (viewerToken) await request(base, viewerToken, '/api/v1/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    if (adminToken) {
      for (const id of [ids.menu, ids.report, ids.query]) {
        const saved = savedConfigs.get(id);
        if (saved) await request(base, adminToken, `/api/v1/configs/${encodeURIComponent(id)}?version=${saved.version}`, { method: 'DELETE' }).catch(() => {});
      }
      if (connection?.id) await request(base, adminToken, `/api/v1/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' }).catch(() => {});
      if (dataFile?.id) await request(base, adminToken, `/api/v1/data-files/${encodeURIComponent(dataFile.id)}`, { method: 'DELETE' }).catch(() => {});
      if (viewer?.id) await request(base, adminToken, `/api/v1/users/${encodeURIComponent(viewer.id)}`, { method: 'PUT', body: { permissions: [], disabled: false } }).catch(() => {});
      await request(base, adminToken, '/api/v1/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    }
  }
});
