import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, expect } from '../../client/node_modules/@playwright/test/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sessionPath = process.env.RIGHTDATA_SCREEN_SESSION || path.join(root, 'test/runtime/client-screen-session.json');
const backendSession = JSON.parse((await readFile(sessionPath, 'utf8')).replace(/^\uFEFF/, ''));
const backend = { ...backendSession, address: backendSession.address || backendSession.baseUrl };
const nativeSession = JSON.parse((await readFile(path.join(root, 'test/runtime/client-native-session.json'), 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(backend.address).hostname, '127.0.0.1', 'screen tests require the dedicated loopback backend');
assert.ok(!['8003', '18003'].includes(new URL(backend.address).port), 'screen tests must not modify the existing servers');
assert.equal(nativeSession.port, 9225, 'screen tests require the dedicated test WebView');
await expect.poll(() => fetch('http://127.0.0.1:9225/json/version', { signal: AbortSignal.timeout(2000) }).then(response => response.ok).catch(() => false), { timeout: 30_000, message: 'the isolated native WebView must be ready before connecting' }).toBe(true);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
const context = browser.contexts()[0];
const page = context.pages().find(item => item.url().includes(':1420')) || context.pages()[0];
assert.ok(page, 'native test WebView is unavailable');

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const ids = { query: `native-screen-query-${suffix}`, screen: `native-screen-${suffix}`, menu: `native-screen-menu-${suffix}` };
const scratch = path.join(root, 'test/runtime', `screen-fixture-${suffix}`);
const viewerCredentials = { username: `screen_viewer_${suffix}`, password: `ScreenViewer-${randomUUID()}` };
const checks = [];
const createdConfigIds = [];
const secrets = [backend.password, viewerCredentials.password];
let databaseId, viewerId, adminToken, serviceWasEnabled, originalSettings, activeFrame;
let action = 'initialization';

const redact = value => secrets.reduce((output, secret) => secret ? output.replaceAll(secret, '[redacted]') : output, value instanceof Error ? value.message : String(value));
async function invoke(command, request) {
  action = `${command}${request?.path ? ` ${request.path}` : ''}`;
  const result = await page.evaluate(async ({ command, request }) => {
    try { return { ok: true, data: await window.__TAURI_INTERNALS__.invoke(command, request === undefined ? undefined : { request }) }; }
    catch (error) { return { ok: false, error: typeof error === 'object' && error ? { code: error.code, message: error.message, status: error.status } : String(error) }; }
  }, { command, request });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}
async function api(method, endpoint, body) {
  const response = await invoke('api_request', { method, path: endpoint, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `native-screen-${randomUUID()}` }) });
  if (response.status >= 400 || response.data?.code !== 'ok') throw new Error(`${endpoint}: ${response.status} ${response.data?.code} ${response.data?.message}`);
  return response.data.data;
}
// This independent administrator connection belongs to the test harness; its token never enters a WebView.
async function admin(method, endpoint, body) {
  action = `harness ${method} ${endpoint}`;
  const response = await fetch(`${backend.address}${endpoint}`, { method, headers: { 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}), 'Idempotency-Key': `screen-harness-${randomUUID()}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 'ok') throw new Error(`${endpoint}: ${response.status} ${envelope.code} ${envelope.message}`);
  return envelope.data;
}
async function saveConfig(id, kind, name, body) {
  const saved = await api('PUT', `/api/v1/configs/${id}`, { kind, name, body, version: 0 });
  createdConfigIds.push(id);
  return saved;
}
async function packageVersion(version) {
  const folder = path.join(scratch, version);
  await mkdir(folder, { recursive: true });
  for (const name of ['index.html', 'screen.css', 'screen.js']) {
    let source = await readFile(path.join(root, 'client/screen-template', name), 'utf8');
    if (name === 'screen.js') source = source.replace('replace-with-bound-definition-id', ids.query).replace("amountField: '金额'", "amountField: 'amount'") + `\nfetch('./fixture.json').then(response=>response.json()).then(value=>document.body.dataset.localJson=value.version);\n`;
    await writeFile(path.join(folder, name), source);
  }
  await writeFile(path.join(folder, 'fixture.json'), JSON.stringify({ version }));
  const output = path.join(scratch, `screen-${version}.zip`);
  execFileSync(process.env.RIGHTDATA_PYTHON || 'py', [...(process.env.RIGHTDATA_PYTHON ? [] : ['-3']), path.join(root, 'client/screen-template/pack.py'), '--source', folder, '--output', output, '--screen-id', ids.screen, '--version', version], { cwd: root, stdio: 'pipe' });
  return output;
}
async function upload(filePath) {
  const response = await invoke('api_upload', { path: `/api/v1/screens/${ids.screen}/versions`, filePath, fileName: path.basename(filePath), mediaType: 'application/zip', fields: {} });
  assert.equal(response.status, 200);
  assert.equal(response.data.code, 'ok');
  return response.data.data;
}
async function publish(version, expectedRevision) { return admin('POST', `/api/v1/screens/${ids.screen}/publish`, { version, expectedRevision }); }
async function protocolStatus(url) { return page.evaluate(async url => { try { return (await fetch(url, { cache: 'no-store' })).status; } catch { return 0; } }, url); }
async function visibleFrame() {
  await expect(page.locator('iframe[title="数据大屏"]')).toBeVisible({ timeout: 30_000 });
  const handle = await page.locator('iframe[title="数据大屏"]').elementHandle();
  const frame = await handle.contentFrame();
  assert.ok(frame);
  return frame;
}
async function replacedFrame(previous) {
  await expect.poll(() => previous.isDetached(), { timeout: 30_000, message: 'the previous program frame must be replaced after a successful reload' }).toBe(true);
  return visibleFrame();
}

try {
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke), { timeout: 20_000 });
  serviceWasEnabled = (await invoke('network_service_get_state')).enabled;
  originalSettings = (await invoke('transport_get_state')).settings;
  if (!serviceWasEnabled) await invoke('network_service_set_enabled', { enabled: true });
  await invoke('transport_configure', { serverUrl: backend.address, discoveryUrl: null, allowPublicRelay: false, rebindInstance: true });
  await invoke('auth_login', { username: backend.username, password: backend.password, remember: false });
  const adminSession = await admin('POST', '/api/v1/auth/login', { username: backend.username, password: backend.password, remember: false });
  adminToken = adminSession.accessToken;
  secrets.push(adminToken);
  const databasePassword = `ScreenDatabase-${randomUUID()}`;
  secrets.push(databasePassword);
  databaseId = (await api('POST', '/api/v1/data-files', { name: `screen-${suffix}.duckdb`, password: databasePassword })).id;
  await api('POST', `/api/v1/datasets/${databaseId}/schema:mutate`, { action: 'create_table', table: 'screen_rows', fields: [{ name: 'city', dataType: 'VARCHAR' }, { name: 'product', dataType: 'VARCHAR' }, { name: 'amount', dataType: 'DECIMAL(30,2)' }] });
  await api('POST', `/api/v1/datasets/${databaseId}/tables/screen_rows/records:mutate`, { operations: [{ action: 'insert', values: { city: '贵阳', product: '真实大屏数据', amount: '123456789012345678.90' } }, { action: 'insert', values: { city: '遵义', product: '真实大屏数据', amount: '0.10' } }] });
  await saveConfig(ids.query, 'query', `大屏查询 ${suffix}`, { datasetId: databaseId, permissions: [], sql: 'SELECT city, product, amount FROM screen_rows ORDER BY city' });
  let screenConfig = await saveConfig(ids.screen, 'screen', `原生大屏 ${suffix}`, { enabled: true, permissions: [], definitionIds: [ids.query], parameters: [] });
  await saveConfig(ids.menu, 'menu', `原生大屏 ${suffix}`, { enabled: true, permissions: [], parentId: '', order: 985, resourceId: ids.screen, resourceKind: 'screen' });
  const file1 = await packageVersion('1.0.0');
  const file2 = await packageVersion('2.0.0');
  const version1 = await upload(file1);
  const version2 = await upload(file2);
  assert.equal(version1.sha256, createHash('sha256').update(await readFile(file1)).digest('hex'));
  assert.equal((await upload(file1)).sha256, version1.sha256);
  const preview = await invoke('screen_prepare', { resourceId: ids.screen, version: '2.0.0', preview: true });
  assert.equal(preview.version, '2.0.0');
  await invoke('screen_release', { baseUrl: preview.baseUrl });
  assert.notEqual(await protocolStatus(`${preview.baseUrl}fixture.json`), 200);
  await invoke('preview_open', { resourceId: ids.screen, title: `大屏草稿 ${suffix}`, draft: { ...screenConfig, previewVersion: '2.0.0', body: { ...screenConfig.body, enabled: false } }, params: {} });
  await expect.poll(() => context.pages().some(item => item !== page && item.url().includes('preview=')), { timeout: 20_000 }).toBe(true);
  const previewPage = context.pages().find(item => item !== page && item.url().includes('preview='));
  assert.ok(previewPage);
  const previewFrame = previewPage.frameLocator('iframe[title="数据大屏"]');
  await expect(previewFrame.locator('body')).toHaveAttribute('data-local-json', '2.0.0', { timeout: 30_000 });
  await expect(previewFrame.locator('#row-count')).toHaveText('2', { timeout: 30_000 });
  const previewBaseUrl = await previewFrame.locator('body').evaluate(() => document.baseURI);
  assert.notEqual(await protocolStatus(`${previewBaseUrl}fixture.json`), 200, 'local asset authorization is scoped to the preview window');
  await publish('1.0.0', 0);
  checks.push('native ZIP upload checks digest and immutable retry; the independent preview opens an unpublished version with an unsaved disabled draft, authorized data and window-scoped local assets');

  const viewer = await admin('POST', '/api/v1/users', { ...viewerCredentials, permissions: ['resources.read', 'data.read'] });
  viewerId = viewer.id;
  await admin('PUT', `/api/v1/users/${viewerId}/grants`, { datasetId: databaseId, table: 'screen_rows', operations: ['read'], columns: ['*'], rowFilter: null });
  await invoke('auth_logout');
  await expect.poll(() => previewPage.isClosed()).toBe(true);
  await invoke('auth_login', { ...viewerCredentials, remember: false });
  await page.reload();
  await expect(page.getByRole('button', { name: viewerCredentials.username, exact: false })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(menuId => { location.hash = `resource:${menuId}`; }, ids.menu);
  activeFrame = await visibleFrame();
  await expect(activeFrame.locator('#row-count')).toHaveText('2', { timeout: 30_000 });
  await expect(activeFrame.locator('#amount-total')).toHaveText('123,456,789,012,345,679');
  await expect(activeFrame.locator('body')).toHaveAttribute('data-local-json', '1.0.0');
  assert.ok(await activeFrame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'precise long metrics must stay within the screen viewport');
  const isolation = await activeFrame.evaluate(async () => {
    let parentReadable = false, remoteAllowed = false, ipcAllowed = false;
    try { parentReadable = !!parent.document; } catch {}
    try { await fetch('https://blocked.example/screen'); remoteAllowed = true; } catch {}
    if (window.__TAURI_INTERNALS__?.invoke) {
      try { ipcAllowed = !!await Promise.race([window.__TAURI_INTERNALS__.invoke('transport_get_state'), new Promise((_, reject) => setTimeout(() => reject(new Error('denied')), 1500))]); } catch {}
    }
    return { ipcAllowed, parentReadable, remoteAllowed, background: getComputedStyle(document.documentElement).backgroundColor, layout: getComputedStyle(document.querySelector('.screen-shell')).display, token: typeof window.accessToken };
  });
  assert.deepEqual({ ipcAllowed: isolation.ipcAllowed, parentReadable: isolation.parentReadable, remoteAllowed: isolation.remoteAllowed, token: isolation.token }, { ipcAllowed: false, parentReadable: false, remoteAllowed: false, token: 'undefined' });
  assert.equal(isolation.background, 'rgb(7, 17, 31)');
  assert.equal(isolation.layout, 'grid');
  await page.getByRole('button', { name: '进入全屏' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await assert.rejects(invoke('screen_prepare', { resourceId: ids.screen, version: '2.0.0', preview: true }), /403|forbidden|权限/);
  const ordinary = await invoke('screen_prepare', { resourceId: ids.screen, version: '2.0.0', preview: false });
  assert.equal(ordinary.version, '1.0.0', 'ordinary callers cannot choose an unpublished version');
  assert.equal(await protocolStatus(`${ordinary.baseUrl}fixture.json`), 200);
  assert.equal((await invoke('screen_prepare', { resourceId: ids.screen })).cacheHit, true);
  checks.push('ordinary viewer without config or file permissions loads module JS, relative CSS and local JSON, queries bound data precisely, and cannot access IPC, parent DOM, remote network or draft versions');

  const state = await invoke('transport_get_state');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const cachedJson = path.join(nativeSession.runtime, 'state/screens', digest(state.settings.boundInstanceId), digest(ids.screen), '1.0.0', version1.sha256, 'content/fixture.json');
  assert.equal(JSON.parse(await readFile(cachedJson, 'utf8')).version, '1.0.0');
  await writeFile(cachedJson, '{"version":"tampered"}');
  assert.notEqual(await protocolStatus(`${ordinary.baseUrl}fixture.json`), 200);
  const repaired = await invoke('screen_prepare', { resourceId: ids.screen });
  assert.equal(repaired.cacheHit, false);
  assert.equal(JSON.parse(await readFile(cachedJson, 'utf8')).version, '1.0.0');
  await invoke('screen_release', { baseUrl: repaired.baseUrl });
  checks.push('native cache detects a modified resource on read and verifies a fresh download before restoring the cache');

  await invoke('network_service_set_enabled', { enabled: false });
  await assert.rejects(api('POST', `/api/v1/resources/${ids.screen}/execute`, { definitionId: ids.query, params: {} }), /network_service_paused|本机网络服务已暂停/);
  await page.locator('.rd-screen-runtime-toolbar').getByRole('button', { name: '刷新' }).click();
  await expect(page.locator('.rd-screen-runtime .ant-alert')).toBeVisible();
  await expect(activeFrame.locator('body')).toHaveAttribute('data-local-json', '1.0.0');
  await activeFrame.getByRole('button', { name: '查询', exact: true }).click();
  await expect(activeFrame.locator('#status')).toHaveText('本机网络服务已暂停');
  await expect(activeFrame.locator('#row-count')).toHaveText('--');
  await invoke('network_service_set_enabled', { enabled: true });
  await page.locator('.rd-screen-runtime-toolbar').getByRole('button', { name: '刷新' }).click();
  activeFrame = await replacedFrame(activeFrame);
  await expect(activeFrame.locator('#row-count')).toHaveText('2');
  checks.push('a paused network retains the verified program after refresh failure, rejects data queries and clears old results; restoring the network reloads current data');

  await publish('2.0.0', 1);
  await assert.rejects(api('GET', `/api/v1/screens/${ids.screen}/versions/1.0.0/download`), /403|404|forbidden|权限|版本/);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: '加载 2.0.0' })).toBeVisible();
  await expect(activeFrame.locator('body')).toHaveAttribute('data-local-json', '1.0.0');
  await page.getByRole('button', { name: '加载 2.0.0' }).click();
  activeFrame = await replacedFrame(activeFrame);
  await expect(activeFrame.locator('body')).toHaveAttribute('data-local-json', '2.0.0');
  await publish('1.0.0', 2);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: '加载 1.0.0' }).click();
  activeFrame = await replacedFrame(activeFrame);
  await expect(activeFrame.locator('body')).toHaveAttribute('data-local-json', '1.0.0');
  await expect(activeFrame.locator('#row-count')).toHaveText('2');
  checks.push('publication changes are offered without interrupting the running screen and rollback reloads the earlier verified version');
  await page.screenshot({ path: path.join(root, 'test/results/client-native-screen.png'), fullPage: true });

  const logoutHandle = await invoke('screen_prepare', { resourceId: ids.screen });
  assert.equal(await protocolStatus(`${logoutHandle.baseUrl}fixture.json`), 200);
  await invoke('auth_logout');
  assert.notEqual(await protocolStatus(`${logoutHandle.baseUrl}fixture.json`), 200);
  checks.push('logout revokes a native resource URL that was positively verified immediately before logout');
  await invoke('auth_login', { ...viewerCredentials, remember: false });
  await page.reload();
  await expect(page.getByRole('button', { name: viewerCredentials.username, exact: false })).toBeVisible({ timeout: 30_000 });
  activeFrame = await visibleFrame();
  await expect(activeFrame.locator('#row-count')).toHaveText('2', { timeout: 30_000 });

  screenConfig = await admin('PUT', `/api/v1/configs/${ids.screen}`, { kind: 'screen', name: screenConfig.name, body: { ...screenConfig.body, enabled: false }, version: screenConfig.version });
  await assert.rejects(invoke('screen_prepare', { resourceId: ids.screen }), /403|404|disabled|not_found|权限|停用|不存在/);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('iframe[title="数据大屏"]')).toHaveCount(0);
  await invoke('auth_logout');
  checks.push('disabled resource cannot be reopened from cache and its active frame is cleared');
  await writeFile(path.join(root, 'test/results/client-native-screen.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const description = `${action}: ${redact(error)}`;
  await page.screenshot({ path: path.join(root, 'test/results/client-native-screen-failure.png'), fullPage: true }).catch(() => {});
  const screens = await Promise.all(context.pages().map(async item => ({ url: item.url(), frames: await Promise.all(item.frames().map(frame => frame.locator('body').innerText().then(redact).catch(() => ''))) })));
  await writeFile(path.join(root, 'test/results/client-native-screen.json'), JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: description, screens }, null, 2));
  throw new Error(description);
} finally {
  if (adminToken) {
    if (viewerId) await admin('PUT', `/api/v1/users/${viewerId}`, { permissions: [], disabled: true }).catch(() => {});
    for (const id of [...createdConfigIds].reverse()) {
      const list = await admin('GET', '/api/v1/configs').catch(() => ({ items: [] }));
      const saved = list.items.find(item => item.id === id);
      if (saved) await admin('DELETE', `/api/v1/configs/${id}?version=${saved.version}`).catch(() => {});
    }
    if (databaseId) await admin('DELETE', `/api/v1/data-files/${databaseId}`).catch(() => {});
    await admin('POST', '/api/v1/auth/logout', {}).catch(() => {});
  }
  await invoke('auth_logout').catch(() => {});
  if (originalSettings) await invoke('transport_configure', { ...originalSettings, rebindInstance: true }).catch(() => {});
  if (serviceWasEnabled === false) await invoke('network_service_set_enabled', { enabled: false }).catch(() => {});
  await page.reload().catch(() => {});
  await browser.close();
  const verifiedScratch = path.resolve(scratch);
  assert.ok(verifiedScratch.startsWith(path.resolve(root, 'test/runtime') + path.sep));
  await rm(verifiedScratch, { recursive: true, force: true });
}
