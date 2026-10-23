import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '../../client/node_modules/@playwright/test/index.mjs';

const session = JSON.parse((await readFile(new URL('../runtime/client-integration-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
const context = browser.contexts()[0];
const page = context.pages().find(page => page.url().includes(':1420')) || context.pages()[0];
const checks = [];
const invoke = (command, request) => page.evaluate(async ({ command, request }) => {
  try { return await window.__TAURI_INTERNALS__.invoke(command, request ? { request } : undefined); }
  catch (error) { throw new Error(typeof error === 'object' && error ? JSON.stringify({ code: error.code, message: error.message, status: error.status }) : String(error)); }
}, { command, request });
const api = async (method, path, body) => {
  const result = await invoke('api_request', { method, path, body, idempotencyKey: method === 'GET' ? undefined : crypto.randomUUID() });
  if (result.status >= 400 || result.data?.code !== 'ok') throw new Error(`${method} ${path}: ${result.data?.message || result.status}`);
  return result.data.data;
};
let resourceId;
let menuId;
try {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, { timeout: 20000 });
  await invoke('transport_configure', { serverUrl: session.address, allowPublicRelay: false, rebindInstance: true });
  await invoke('auth_logout');
  await page.reload();
  await expect(page.getByRole('heading', { name: '用户登录' })).toBeVisible({ timeout: 30000 });
  await page.getByLabel('账号', { exact: true }).fill(session.username);
  await page.getByLabel('密码', { exact: true }).fill(session.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('我的报表与看板', { exact: true })).toBeVisible({ timeout: 30000 });
  checks.push('native login through Rust to isolated backend');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(session.password);
  expect(storage).not.toMatch(/accessToken|refreshToken/);
  checks.push('WebView storage contains no login credentials');
  await page.reload();
  await expect(page.getByText('我的报表与看板', { exact: true })).toBeVisible({ timeout: 30000 });
  checks.push('native session restores after the main WebView reloads');
  const update = await invoke('client_update_check');
  expect(update.available).toBe(false);
  expect(update.currentVersion).toBe('0.1.0');
  checks.push('an internal no-update response ends update checking without a public fallback');

  await page.evaluate(() => { location.hash = 'docs'; });
  const docs = page.frameLocator('iframe[title="服务端接口文档"]');
  await expect(docs.locator('.swagger-ui .info .title')).toBeVisible({ timeout: 40000 });
  await expect(docs.getByText('Failed to load API definition.')).toHaveCount(0);
  const docPaths = await docs.locator('.opblock').count();
  expect(docPaths).toBeGreaterThan(5);
  checks.push(`Swagger loaded ${docPaths} endpoints through Rust`);
  const meOperation = docs.locator('.opblock').filter({ has: docs.getByText('/api/v1/auth/me', { exact: true }) });
  await meOperation.locator('.opblock-summary').click();
  await meOperation.getByRole('button', { name: 'Try it out', exact: true }).click();
  await meOperation.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(meOperation.locator('.live-responses-table')).toContainText(session.username, { timeout: 15000 });
  checks.push('Swagger online execution receives the native authenticated API response');
  await page.screenshot({ path: new URL('../results/client-native-docs.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });

  const suffix = Date.now().toString(36);
  resourceId = `native-smoke-${suffix}`;
  menuId = `native-menu-${suffix}`;
  const draft = { id: resourceId, kind: 'h5', name: '原生预览验证', version: 0, body: { enabled: true, permissions: [], definitionIds: [], html: '<main><h2>原生隔离验证</h2><p id="safe"></p><script>(async()=>{let protectedParent=false;try{parent.document.body}catch{protectedParent=true}let nativeAccess="blocked";if(window.__TAURI_INTERNALS__){try{const result=await Promise.race([window.__TAURI_INTERNALS__.invoke("transport_get_state"),new Promise((_,reject)=>setTimeout(()=>reject(Error("denied")),1500))]);if(result)nativeAccess="allowed"}catch{}}document.querySelector("#safe").textContent=nativeAccess+":"+protectedParent})()</script></main>' } };
  const saved = await api('PUT', `/api/v1/configs/${resourceId}`, draft);
  await api('PUT', `/api/v1/configs/${menuId}`, { kind: 'menu', name: '原生预览验证', version: 0, body: { enabled: true, permissions: [], resourceId, resourceKind: 'h5', order: 99 } });
  await page.evaluate(id => { window.dispatchEvent(new Event('focus')); location.hash = `resource:${id}`; }, menuId);
  const ordinaryFrame = page.frameLocator('iframe[title="通报内容"]');
  await expect(ordinaryFrame.locator('#safe')).toHaveText('blocked:true', { timeout: 20000 });
  await page.getByRole('button', { name: '进入全屏' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  checks.push('ordinary authorized resource opens in the main window and enters/exits actual WebView fullscreen');

  await invoke('preview_open', { resourceId, title: draft.name, draft: saved, params: { region: '贵阳' } });
  await expect.poll(() => context.pages().some(item => item !== page && item.url().includes('preview=')), { timeout: 20000 }).toBe(true);
  const preview = context.pages().find(item => item !== page && item.url().includes('preview='));
  if (!preview) throw new Error('No native preview WebView appeared');
  const report = preview.frameLocator('iframe');
  await expect(report.locator('#safe')).toHaveText('blocked:true', { timeout: 20000 });
  expect(new URL(preview.url()).searchParams.has('token')).toBe(false);
  const previewState = await preview.evaluate(() => window.__TAURI_INTERNALS__.invoke('preview_get_state'));
  expect(previewState.params).toEqual({ region: '贵阳' });
  checks.push('native preview shares session and opaque iframe cannot access parent or native bridge');
  await preview.getByRole('button', { name: '进入全屏' }).click();
  await expect.poll(() => preview.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await preview.keyboard.press('Escape');
  await expect.poll(() => preview.evaluate(() => document.fullscreenElement === null)).toBe(true);
  checks.push('independent preview receives its own parameters and supports actual WebView fullscreen');
  const revised = { ...saved, body: { ...saved.body, html: '<p id="revision">草稿已更新</p>' } };
  await invoke('preview_open', { resourceId, title: draft.name, draft: revised, params: {} });
  await expect(report.locator('#revision')).toHaveText('草稿已更新', { timeout: 20000 });
  expect(context.pages().length).toBe(2);
  checks.push('preview reuses resource window and loads newest draft');
  await api('DELETE', `/api/v1/configs/${menuId}?version=1`); menuId = undefined;
  await api('DELETE', `/api/v1/configs/${resourceId}?version=1`); resourceId = undefined;
  await invoke('auth_logout');
  await page.reload();
  await expect(page.getByRole('heading', { name: '用户登录' })).toBeVisible({ timeout: 20000 });
  await expect.poll(() => context.pages().length).toBe(1);
  checks.push('logout clears native session and closes previews');
  await writeFile(new URL('../results/client-native-smoke.json', import.meta.url), JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  await writeFile(new URL('../results/client-native-smoke.json', import.meta.url), JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: String(error) }, null, 2));
  throw error;
} finally {
  if (menuId) await api('DELETE', `/api/v1/configs/${menuId}?version=1`).catch(() => {});
  if (resourceId) await api('DELETE', `/api/v1/configs/${resourceId}?version=1`).catch(() => {});
  await browser.close();
}
