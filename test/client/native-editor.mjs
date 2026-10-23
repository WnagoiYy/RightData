import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '../../client/node_modules/@playwright/test/index.mjs';

const session = JSON.parse((await readFile(new URL('../runtime/client-integration-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
const page = browser.contexts()[0].pages().find(item => item.url().includes(':1420'));
if (!page) throw new Error('The isolated native test WebView is unavailable.');
const checks = [];
const errors = [];
const workers = [];
let resourceId;
let serviceWasEnabled;
const invoke = (command, request) => page.evaluate(async ({ command, request }) => {
  try { return await window.__TAURI_INTERNALS__.invoke(command, request ? { request } : undefined); }
  catch (error) { throw new Error(typeof error === 'object' && error ? JSON.stringify({ code: error.code, message: error.message, status: error.status }) : String(error)); }
}, { command, request });
const api = async (method, path, body) => {
  const result = await invoke('api_request', { method, path, body, idempotencyKey: method === 'GET' ? undefined : randomUUID() });
  if (result.status >= 400 || result.data?.code !== 'ok') throw new Error(`${method} ${path}: ${result.data?.message || result.status}`);
  return result.data.data;
};
try {
  serviceWasEnabled = (await invoke('network_service_get_state')).enabled;
  if (!serviceWasEnabled) await invoke('network_service_set_enabled', { enabled: true });
  await invoke('transport_configure', { serverUrl: session.address, allowPublicRelay: false, rebindInstance: true });
  await invoke('auth_login', { username: session.username, password: session.password, remember: false });
  resourceId = `native-editor-${randomUUID()}`;
  const name = `原生编辑验证 ${resourceId.slice(-8)}`;
  await api('PUT', `/api/v1/configs/${resourceId}`, { kind: 'h5', name, version: 0, body: { enabled: true, permissions: [], definitionIds: [], html: '<main><h1>Initial</h1></main>' } });
  page.on('console', item => { if (item.type() === 'error' && /worker|content security policy|module script/i.test(item.text())) errors.push(item.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => workers.push(worker.url()));
  await page.reload();
  await expect(page.getByRole('button', { name: session.username, exact: false })).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => { location.hash = 'bulletins'; });
  await page.locator('.rd-config-name-button').filter({ hasText: name }).click();
  const editor = page.getByRole('textbox', { name: /通报 HTML 源码/ });
  await expect(editor).toBeVisible({ timeout: 30000 });
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('<main><h1>Native saved</h1><style>h1{color:blue}</style><script>const value={count:1};</script></main>');
  await page.keyboard.press('Shift+Alt+F');
  await expect(page.getByText('HTML、CSS 和 JavaScript 已格式化', { exact: true })).toBeVisible();
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+S');
  await expect.poll(async () => {
    const response = await api('GET', '/api/v1/configs?kind=h5');
    return response.items.find(item => item.id === resourceId)?.version;
  }, { timeout: 20000 }).toBe(2);
  const saved = (await api('GET', '/api/v1/configs?kind=h5')).items.find(item => item.id === resourceId);
  expect(saved.body.html).toContain('Native saved');
  expect(saved.body.html).toContain('color: blue;');
  expect(saved.body.html).toContain('count: 1');
  expect(saved.body.html.replaceAll('\r\n', '\n').trim()).toBe('<main>\n  <h1>Native saved</h1>\n  <style>\n    h1 {\n      color: blue;\n    }\n  </style>\n  <script>\n    const value = { count: 1 };\n  </script>\n</main>');
  checks.push('native Monaco HTML editor formats embedded CSS/JavaScript and Ctrl+S saves the current draft through Rust');
  await expect.poll(() => workers.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(workers.every(url => url.startsWith('http://localhost:1420/') || url.startsWith('http://127.0.0.1:1420/'))).toBe(true);
  expect(errors).toEqual([]);
  checks.push('editor workers load from the local client with no CDN or worker/CSP errors in the native WebView');
  await page.screenshot({ path: new URL('../results/client-native-editor.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await writeFile(new URL('../results/client-native-editor.json', import.meta.url), JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const description = String(error).replaceAll(session.password, '[redacted]');
  await writeFile(new URL('../results/client-native-editor.json', import.meta.url), JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: description }, null, 2));
  throw new Error(description);
} finally {
  if (resourceId) {
    const current = await api('GET', '/api/v1/configs?kind=h5').catch(() => ({ items: [] }));
    const saved = current.items.find(item => item.id === resourceId);
    if (saved) await api('DELETE', `/api/v1/configs/${resourceId}?version=${saved.version}`).catch(() => {});
  }
  await invoke('auth_logout').catch(() => {});
  if (serviceWasEnabled === false) await invoke('network_service_set_enabled', { enabled: false }).catch(() => {});
  await page.reload().catch(() => {});
  await browser.close();
}
