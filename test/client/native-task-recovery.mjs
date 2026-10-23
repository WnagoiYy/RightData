import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '../../client/node_modules/@playwright/test/index.mjs';

const session = JSON.parse((await readFile(new URL('../runtime/client-integration-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
const page = browser.contexts()[0].pages().find(item => item.url().includes(':1420'));
if (!page) throw new Error('The isolated native test WebView is unavailable.');
const checks = [];
let databaseId;
let serviceWasEnabled;
const invoke = (command, request) => page.evaluate(async ({ command, request }) => {
  try { return await window.__TAURI_INTERNALS__.invoke(command, request ? { request } : undefined); }
  catch (error) { throw new Error(typeof error === 'object' && error ? JSON.stringify({ code: error.code, message: error.message, status: error.status }) : String(error)); }
}, { command, request });
const api = async (method, path, body) => {
  const result = await invoke('api_request', { method, path, body, idempotencyKey: method === 'GET' ? undefined : randomUUID() }).catch(cause => { throw new Error(`${method} ${path}: ${String(cause)}`); });
  if (result.status >= 400 || result.data?.code !== 'ok') throw new Error(`${method} ${path}: ${result.data?.message || result.status}`);
  return result.data.data;
};
try {
  serviceWasEnabled = (await invoke('network_service_get_state')).enabled;
  if (!serviceWasEnabled) await invoke('network_service_set_enabled', { enabled: true });
  await invoke('transport_configure', { serverUrl: session.address, allowPublicRelay: false, rebindInstance: true });
  await invoke('auth_login', { username: session.username, password: session.password, remember: false });
  const suffix = randomUUID().slice(0, 8);
  const database = await api('POST', '/api/v1/data-files', { name: `native-recovery-${suffix}.duckdb`, password: `Recovery-${randomUUID()}` });
  databaseId = database.id;
  await api('POST', `/api/v1/datasets/${encodeURIComponent(databaseId)}/schema:mutate`, { action: 'create_table', table: 'recovery_rows', fields: [{ name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true }, { name: 'label', dataType: 'VARCHAR' }] });
  await api('POST', `/api/v1/datasets/${encodeURIComponent(databaseId)}/tables/recovery_rows/records:mutate`, { operations: [{ action: 'insert', values: { id: '9007199254740993', label: '原生任务恢复' } }] });
  const task = await api('POST', '/api/v1/export-jobs', { datasetId: databaseId, table: 'recovery_rows', fields: ['id', 'label'] });
  await expect.poll(async () => (await api('GET', `/api/v1/jobs/${task.jobId}`)).state, { timeout: 45000 }).toBe('succeeded');
  await page.reload();
  await expect(page.getByRole('button', { name: session.username, exact: false })).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => { location.hash = 'data'; });
  await expect(page.getByRole('button', { name: '恢复', exact: true })).not.toHaveClass(/ant-btn-loading/);
  await page.getByLabel('导出任务 ID', { exact: true }).fill(task.jobId);
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-job-id', task.jobId);
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-state', 'succeeded');
  checks.push('a real completed export is recovered by task ID through the native Rust connection');
  await page.reload();
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-job-id', task.jobId, { timeout: 30000 });
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-state', 'succeeded');
  checks.push('the main WebView reload restores the persisted task reference and rechecks the backend state');
  await page.evaluate(() => { location.hash = 'export-log'; });
  await expect(page.getByText('提交导出', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(task.jobId, { exact: true }).first()).toBeVisible();
  checks.push('the real export submission appears under the export log category');
  await writeFile(new URL('../results/client-native-task-recovery.json', import.meta.url), JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const description = String(error).replaceAll(session.password, '[redacted]');
  const pageText = (await page.locator('body').innerText().catch(() => '')).replaceAll(session.password, '[redacted]');
  await writeFile(new URL('../results/client-native-task-recovery.json', import.meta.url), JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: description, pageText }, null, 2));
  throw new Error(description);
} finally {
  if (databaseId) await api('DELETE', `/api/v1/data-files/${encodeURIComponent(databaseId)}`).catch(() => {});
  await invoke('auth_logout').catch(() => {});
  if (serviceWasEnabled === false) await invoke('network_service_set_enabled', { enabled: false }).catch(() => {});
  await page.reload().catch(() => {});
  await browser.close();
}
