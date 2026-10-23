import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

let control;

test.beforeEach(async ({ page }) => {
  control = await installNativeMock(page);
});

test('独立预览携带编辑器中的当前筛选参数', async ({ page }) => {
  const report = control.configs.get('daily-report');
  control.configs.set('daily-report', {
    ...report,
    body: {
      ...report.body,
      parameters: [{ key: 'city', label: '地市', type: 'text', defaultValue: '贵阳' }],
    },
  });

  await page.goto('/#reports');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日常明细' }).click();
  const city = page.locator('.rd-config-param').filter({ hasText: '地市' }).getByRole('textbox');
  await expect(city).toHaveValue('贵阳');
  await city.fill('遵义');
  await page.getByRole('button', { name: '独立预览' }).click();

  await expect.poll(() => control.requests.filter(request => request.command === 'preview_open').length).toBe(1);
  const preview = control.requests.find(request => request.command === 'preview_open');
  expect(preview.resourceId).toBe('daily-report');
  expect(preview.params).toEqual({ city: '遵义' });
});

test('载入本机保存记录只恢复内容并继续使用当前服务器版本', async ({ page }) => {
  await page.goto('/#reports');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日常明细' }).click();

  const name = page.getByLabel('配置名称');
  await name.fill('本机快照名称');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.rd-config-drawer-title').getByText('V2', { exact: true })).toBeVisible();

  const saved = control.configs.get('daily-report');
  control.configs.set('daily-report', {
    ...saved,
    name: '服务器当前名称',
    version: 3,
    updatedAt: '2026-10-23T03:00:00Z',
  });
  await page.reload();
  await page.locator('.rd-config-name-button').filter({ hasText: '服务器当前名称' }).click();
  await expect(page.locator('.rd-config-drawer-title').getByText('V3', { exact: true })).toBeVisible();

  await page.getByText('本机保存记录 (1)', { exact: true }).click();
  const putCountBeforeRestore = control.requests.filter(request => request.command === 'api_request' && request.method === 'PUT').length;
  await page.getByRole('button', { name: '载入为草稿' }).click();
  await expect(name).toHaveValue('本机快照名称');
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  await expect.poll(() => control.requests.filter(request => request.command === 'api_request' && request.method === 'PUT').length).toBe(putCountBeforeRestore);

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => control.requests.filter(request => request.command === 'api_request' && request.method === 'PUT').length).toBe(putCountBeforeRestore + 1);
  const saveRequests = control.requests.filter(request => request.command === 'api_request' && request.method === 'PUT');
  expect(saveRequests.at(-1).body.version).toBe(3);
  await expect(page.locator('.rd-config-drawer-title').getByText('V4', { exact: true })).toBeVisible();
});
