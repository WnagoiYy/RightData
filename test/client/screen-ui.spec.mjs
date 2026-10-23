import { createServer } from 'node:http';
import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

const screenModule = `
  document.querySelector('#native-ipc').textContent = typeof window.__TAURI_INTERNALS__;
  window.rightData.query('daily-query', { city: '贵阳' }).then(
    data => document.querySelector('#bound-query').textContent = data.rows[0]['地市'],
    error => document.querySelector('#bound-query').textContent = error.message
  );
  window.rightData.query('forbidden-query').then(
    () => document.querySelector('#forbidden-query').textContent = '越权成功',
    error => document.querySelector('#forbidden-query').textContent = error.message
  );
  fetch('https://blocked.example/business-token').then(
    () => document.querySelector('#external-fetch').textContent = '联网成功',
    () => document.querySelector('#external-fetch').textContent = '已阻止'
  );
`;

const assetRequests = [];
const assetServer = createServer((request, response) => {
  assetRequests.push(request.url || '');
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.url?.endsWith('/screen.css')) {
    response.setHeader('Content-Type', 'text/css; charset=utf-8');
    response.end('body{background:#07152d;color:white}');
    return;
  }
  if (request.url?.endsWith('/screen.js')) {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end(screenModule);
    return;
  }
  response.statusCode = 404;
  response.end('missing');
});

test.beforeAll(async () => {
  await new Promise((resolve, reject) => assetServer.listen(80, '127.0.0.1', error => error ? reject(error) : resolve()));
});

test.afterAll(async () => {
  await new Promise(resolve => assetServer.close(resolve));
});

test.beforeEach(() => { assetRequests.length = 0; });

async function installScreenRoutes(page) {
  const externalRequests = [];
  await page.route('https://blocked.example/**', async route => { externalRequests.push(route.request().url()); await route.abort(); });
  return { externalRequests };
}

function versionRow(page, version) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: new RegExp(`^${version.replaceAll('.', '\\.')}`) }) });
}

async function confirmPublish(page, row, dispatch = false) {
  const trigger = row.getByRole('button', { name: '发布' });
  if (dispatch) await trigger.dispatchEvent('click');
  else await trigger.click();
  await page.locator('.ant-popconfirm').last().getByRole('button', { name: '发布', exact: true }).click();
}

test('大屏版本管理保留不可变版本、冲突预览和回退语义', async ({ page }) => {
  const control = await installNativeMock(page);
  await installScreenRoutes(page);
  await page.goto('/#screen-resources');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益数据大屏' }).click();

  const row2 = versionRow(page, '2.0.0');
  await expect(row2).toBeVisible();
  await expect(page.getByText('已发布 1.0.0')).toBeVisible();
  await row2.getByRole('button', { name: '预览' }).click();
  await expect(row2.locator('.ant-tag').filter({ hasText: '预览' })).toBeVisible();
  await expect.poll(() => control.screenPrepares.at(-1)).toMatchObject({ resourceId: 'daily-screen', version: '2.0.0', preview: true });

  await page.getByRole('button', { name: '独立预览' }).click();
  await expect.poll(() => control.previewOpens.at(-1)?.draft?.previewVersion).toBe('2.0.0');

  control.failNextScreenPublishConflict = true;
  await confirmPublish(page, row2);
  await expect(page.getByText('发布版本已被修改，请核对当前版本后重试')).toBeVisible();
  await expect(row2.locator('.ant-tag').filter({ hasText: '预览' })).toBeVisible();

  await confirmPublish(page, row2);
  await expect(page.locator('.ant-tag').filter({ hasText: '已发布 2.0.0' })).toBeVisible();
  const row1 = versionRow(page, '1.0.0');
  await confirmPublish(page, row1);
  await expect(page.locator('.ant-tag').filter({ hasText: '已发布 1.0.0' })).toBeVisible();
  const publishBodies = control.requests.filter(request => request.path === '/api/v1/screens/daily-screen/publish').map(request => request.body);
  expect(publishBodies).toEqual([
    { version: '2.0.0', expectedRevision: 1 },
    { version: '2.0.0', expectedRevision: 2 },
    { version: '1.0.0', expectedRevision: 3 },
  ]);

  const upload = page.locator('input[type="file"][accept*="zip"]');
  await upload.setInputFiles({ name: 'screen-3.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from('first immutable bytes') });
  const row3 = versionRow(page, '3.0.0');
  await expect(row3).toBeVisible();
  await upload.setInputFiles({ name: 'screen-3.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from('changed immutable bytes') });
  await expect(page.getByText('相同版本已存在且内容不同')).toBeVisible();

  await page.getByLabel('配置名称').fill('尚未保存的大屏名称');
  await expect(page.getByText('保存配置更改后可发布资源版本')).toBeVisible();
  await expect(row3.getByRole('button', { name: '发布' })).toBeDisabled();
});

test('普通入口加载隔离大屏并只允许绑定查询', async ({ page }) => {
  const control = await installNativeMock(page);
  const routes = await installScreenRoutes(page);
  await page.goto('/#screens');
  const galleryRow = page.getByRole('row').filter({ hasText: '权益数据大屏' });
  await expect(galleryRow).toBeVisible();
  await galleryRow.getByRole('button', { name: '打开' }).click();

  const iframe = page.locator('iframe[title="数据大屏"]');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  const srcdoc = await iframe.getAttribute('srcdoc');
  expect(srcdoc).toContain('connect-src http://rd-screen.localhost');
  expect(srcdoc).toMatch(/<base href="http:\/\/rd-screen\.localhost\/screen-\d+\/">/);
  expect(srcdoc).not.toMatch(/authorization|bearer|__TAURI_INTERNALS__|api_request/i);

  const frame = page.frameLocator('iframe[title="数据大屏"]');
  await expect(frame.locator('main')).toHaveAttribute('data-screen-version', '1.0.0');
  await expect(frame.locator('#bound-query')).toHaveText('贵阳');
  await expect(frame.locator('#forbidden-query')).toHaveText('查询定义未绑定到此通报');
  await expect(frame.locator('#external-fetch')).toHaveText('已阻止');
  await expect(frame.locator('#native-ipc')).toHaveText('undefined');
  expect(srcdoc).toContain('href="./screen.css"');
  expect(srcdoc).toContain('src="./screen.js"');
  await expect.poll(() => frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(7, 21, 45)');
  expect(assetRequests.some(path => path.endsWith('/screen.css'))).toBeTruthy();
  expect(assetRequests.some(path => path.endsWith('/screen.js'))).toBeTruthy();
  expect(routes.externalRequests).toEqual([]);

  const resourceRequests = control.requests.filter(request => request.command === 'api_request');
  expect(resourceRequests.some(request => request.path === '/api/v1/resources/daily-screen')).toBeTruthy();
  expect(resourceRequests.some(request => request.path === '/api/v1/resources/daily-screen/execute' && request.body?.definitionId === 'daily-query')).toBeTruthy();
  expect(resourceRequests.some(request => request.body?.definitionId === 'forbidden-query')).toBeFalsy();
});

test('大屏刷新失败保留当前画面，成功切换后释放旧缓存令牌', async ({ page }) => {
  const control = await installNativeMock(page);
  await installScreenRoutes(page);
  await page.goto('/#resource:screen-menu');
  const frame = page.frameLocator('iframe[title="数据大屏"]');
  await expect(frame.locator('main')).toHaveAttribute('data-screen-version', '1.0.0');
  const firstBaseUrl = control.screenPrepares.at(-1).result.baseUrl;

  control.failNextScreenPrepare = { code: 'screen_invalid', message: '资源校验失败' };
  const refresh = page.locator('.rd-screen-runtime-toolbar button').filter({ hasText: '刷新' });
  await refresh.click();
  await expect(page.getByText('资源校验失败')).toBeVisible();
  await expect(frame.locator('main')).toHaveAttribute('data-screen-version', '1.0.0');
  expect(control.screenReleases).not.toContain(firstBaseUrl);

  control.screenPublication = { publishedVersion: control.screenVersions.get('2.0.0'), publishRevision: 2, publishedAt: '2026-10-23T02:00:00Z' };
  await refresh.click();
  await expect(frame.locator('main')).toHaveAttribute('data-screen-version', '2.0.0');
  await expect.poll(() => control.screenReleases).toContain(firstBaseUrl);
});

test('分页旧响应不能覆盖刚完成的发布状态', async ({ page }) => {
  const control = await installNativeMock(page);
  await installScreenRoutes(page);
  const template = control.screenVersions.get('1.0.0');
  for (let index = 1; index <= 21; index += 1) {
    const version = `0.0.${index}`;
    control.screenVersions.set(version, { ...template, version, downloadUrl: `/api/v1/screens/daily-screen/versions/${version}/download` });
  }
  control.screenListDelayMs = 900;
  await page.goto('/#screen-resources');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益数据大屏' }).click();
  const row2 = versionRow(page, '2.0.0');
  await expect(page.getByRole('button', { name: '加载更多版本' })).toBeVisible();
  await page.getByRole('button', { name: '加载更多版本' }).click();
  await expect.poll(() => control.requests.some(request => request.path?.includes('/versions?limit=20&offset=20'))).toBe(true);

  await confirmPublish(page, row2, true);
  await expect(page.locator('.ant-tag').filter({ hasText: '已发布 2.0.0' })).toBeVisible();
  await expect.poll(() => control.screenListCompletions).toContain(20);
  await expect(page.locator('.ant-tag').filter({ hasText: '已发布 2.0.0' })).toBeVisible();
  expect(control.screenPublication.publishRevision).toBe(2);
});

test('待处理上传经历 A 到 B 再回 A 后不会污染新编辑会话', async ({ page }) => {
  const control = await installNativeMock(page);
  await installScreenRoutes(page);
  let releaseUpload;
  control.screenUploadGate = new Promise(resolve => { releaseUpload = resolve; });
  await page.goto('/#screen-resources');
  const daily = page.locator('.rd-config-name-button').filter({ hasText: '权益数据大屏' });
  const secondary = page.locator('.rd-config-name-button').filter({ hasText: '备用数据大屏' });
  await daily.click();
  await page.locator('input[type="file"][accept*="zip"]').setInputFiles({ name: 'screen-4.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from('pending upload') });
  await expect(page.getByRole('button', { name: '上传 ZIP' })).toHaveAttribute('class', /ant-btn-loading/);

  await page.locator('.ant-drawer-extra').getByRole('button', { name: '关闭', exact: true }).click();
  await secondary.click();
  await expect(page.getByLabel('配置名称')).toHaveValue('备用数据大屏');
  await expect(page.getByRole('button', { name: '上传 ZIP' })).toBeEnabled();
  await page.locator('.ant-drawer-extra').getByRole('button', { name: '关闭', exact: true }).click();
  await daily.click();
  await expect(page.getByLabel('配置名称')).toHaveValue('权益数据大屏');
  await expect(page.getByRole('button', { name: '上传 ZIP' })).toBeEnabled();

  releaseUpload();
  await expect.poll(() => control.screenVersions.has('4.0.0')).toBe(true);
  await expect(versionRow(page, '4.0.0')).toHaveCount(0);
  expect(control.screenPrepares.some(item => item.version === '4.0.0')).toBeFalsy();
  await expect(page.getByText('版本已上传')).toHaveCount(0);
});
