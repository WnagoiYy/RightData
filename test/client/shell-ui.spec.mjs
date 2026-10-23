import { test, expect } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

test('login has no preset credentials, defaults to remember, and handles invalid login', async ({ page }) => {
  const control = await installNativeMock(page, { authenticated: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '用户登录' })).toBeVisible();
  await expect(page.getByLabel('账号', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: '记住登录' })).toBeChecked();
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('账号或密码不正确')).toBeVisible();
  const login = page.getByRole('button', { name: '登录', exact: true });
  await expect(login).toBeEnabled();
  await expect(login).not.toHaveClass(/ant-btn-loading/);
  expect(control.requests.filter(request => request.command === 'auth_login')).toHaveLength(1);
  await page.getByLabel('密码', { exact: true }).fill('correct-test-password');
  await login.click();
  await expect(page.getByText('我的报表与看板', { exact: true })).toBeVisible();
  expect(control.requests.filter(request => request.command === 'auth_login')[1]).toMatchObject({ password: 'correct-test-password', remember: true });
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(storage)).not.toContain('password');
  await page.screenshot({ path: '../test/results/client-overview.png', fullPage: true });
});

test('connection settings available before login; public business relay is opt-in', async ({ page }) => {
  const control = await installNativeMock(page, { authenticated: false });
  await page.goto('/');
  await page.getByRole('button', { name: '连接设置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '允许公网业务中继' })).not.toBeChecked();
  await expect(page.getByLabel('节点发现地址')).toHaveValue('https://39.106.128.14');
  await page.getByLabel('服务端地址').fill('http://127.0.0.1:18003');
  await page.getByRole('button', { name: '保存并连接' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(control.settings.serverUrl).toBe('http://127.0.0.1:18003');
  expect(control.settings.allowPublicRelay).toBe(false);
});

test('logged-out startup shows login while connection warms and reuses that probe', async ({ page }) => {
  let releaseProbe;
  const probeGate = new Promise(resolve => { releaseProbe = resolve; });
  const control = await installNativeMock(page, { authenticated: false });
  control.probeGate = probeGate;
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '用户登录' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '连接设置' })).toHaveCount(0);
  expect(control.requests.filter(request => request.command === 'transport_probe')).toHaveLength(1);

  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('correct-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveClass(/ant-btn-loading/);
  expect(control.requests.filter(request => request.command === 'auth_login')).toHaveLength(0);

  releaseProbe();
  await expect(page.getByText('我的报表与看板', { exact: true })).toBeVisible();
  expect(control.requests.filter(request => request.command === 'transport_probe')).toHaveLength(1);
  expect(control.requests.filter(request => request.command === 'auth_login')).toHaveLength(1);
});

test('connection failure stays on login without opening settings', async ({ page }) => {
  const control = await installNativeMock(page, { authenticated: false });
  control.probeError = { code: 'network_error', message: '无法连接服务' };
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '用户登录' })).toBeVisible();
  await expect(page.getByText('无法连接服务')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '连接设置' })).toHaveCount(0);
});

test('business table loads exact BIGINT values through the native bridge', async ({ page }) => {
  const control = await installNativeMock(page);
  await page.goto('/#data');
  await page.getByRole('button', { name: /查询$/ }).click();
  await expect(page.getByText('9007199254740993', { exact: true })).toBeVisible();
  await expect(page.getByText('权益产品 B', { exact: true })).toBeVisible();
  expect(control.requests.some(request => request.path?.endsWith('/query'))).toBe(true);
  const external = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:1420') && !request.url().startsWith('data:')) external.push(request.url()); });
  await page.getByRole('button', { name: /查询$/ }).click();
  expect(external).toEqual([]);
  await page.screenshot({ path: '../test/results/client-query.png', fullPage: true });
});

test('dynamic resource reads use resource endpoints and revocation clears displayed data', async ({ page }) => {
  const control = await installNativeMock(page, { permissions: ['resources.read', 'data.read'] });
  await page.goto('/#resource:daily-menu');
  await expect(page.getByText('9007199254740993', { exact: true })).toBeVisible();
  expect(control.requests.some(request => request.path === '/api/v1/resources/daily-report')).toBe(true);
  expect(control.requests.some(request => request.path?.startsWith('/api/v1/configs'))).toBe(false);
  await expect(page.getByText('用户管理', { exact: true })).toHaveCount(0);
  control.unauthorized = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: '用户登录' })).toBeVisible();
  await expect(page.getByText('9007199254740993', { exact: true })).toHaveCount(0);
});

test('file rename and download use the file API and native destination selection', async ({ page }) => {
  const control = await installNativeMock(page);
  await page.goto('/#files');
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('文件名', { exact: true }).fill('新的口径说明.txt');
  await page.getByRole('button', { name: /确\s*定/ }).click();
  await expect(page.getByText('新的口径说明.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /下载$/ }).click();
  await expect.poll(() => control.downloads.length).toBe(1);
  expect(control.downloads[0]).toMatchObject({ path: '/api/v1/files/guide/download', suggestedName: '新的口径说明.txt' });
});

test('row grant revision clears old rows even when function permissions are unchanged', async ({ page }) => {
  const control = await installNativeMock(page, { permissions: ['data.read'] });
  await page.goto('/#data');
  await page.getByRole('button', { name: /查询$/ }).click();
  await expect(page.getByText('9007199254740993', { exact: true })).toBeVisible();
  control.user.authzRevision = 'grant-revision-2';
  control.rows = control.rows.slice(1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('9007199254740993', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /查询$/ }).click();
  await expect(page.getByText('9007199254740994', { exact: true })).toBeVisible();
  await expect(page.getByText('9007199254740993', { exact: true })).toHaveCount(0);
});

test('small viewport keeps navigation and content reachable without page overflow', async ({ page }) => {
  await installNativeMock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('我的报表与看板', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '数据查询' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../test/results/client-compact.png', fullPage: true });
});
