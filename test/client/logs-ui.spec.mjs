import { test, expect } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

test('import and export logs use job audit records and distinguish submission from completion', async ({ page }) => {
  const control = await installNativeMock(page);
  const base = { createdAt: '2026-10-23T00:00:00Z', actorId: control.user.id, category: 'job', outcome: 'success' };
  control.logs = [
    { ...base, id: 'import-log', action: 'submit_import', target: 'import-test' },
    { ...base, id: 'export-log', action: 'submit_export', target: 'export-test' },
    { ...base, id: 'download-log', action: 'download', target: 'export-test' },
  ];
  await page.goto('/#import-log');
  await expect(page.getByText('提交导入', { exact: true })).toBeVisible();
  await expect(page.getByText('提交导出', { exact: true })).toHaveCount(0);
  await expect(page.getByText('提交成功', { exact: true })).toBeVisible();
  expect(control.requests.some(item => item.path?.startsWith('/api/v1/logs?category=job&'))).toBe(true);
  await page.locator('button.ant-table-row-expand-icon').click();
  await expect(page.getByText('任务状态', { exact: true })).toBeVisible();
  await expect(page.getByText('已完成', { exact: true })).toBeVisible();
  expect(control.requests.some(item => item.path === '/api/v1/jobs/import-test')).toBe(true);
  await page.goto('/#export-log');
  await expect(page.getByText('提交导出', { exact: true })).toBeVisible();
  await expect(page.getByText('下载结果', { exact: true })).toBeVisible();
  await expect(page.getByText('提交导入', { exact: true })).toHaveCount(0);
});

test('job log paging retains the next page when category filtering reduces visible rows', async ({ page }) => {
  const control = await installNativeMock(page, { permissions: ['logs.read'] });
  control.logs = Array.from({ length: 50 }, (_, index) => ({ id: `log-${index}`, category: 'job', action: index === 0 ? 'submit_import' : 'submit_export', target: `job-${index}`, outcome: 'success', createdAt: '2026-10-23T00:00:00Z' }));
  await page.goto('/#import-log');
  await expect(page.getByText('提交导入', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页' })).toBeEnabled();
  await page.locator('button.ant-table-row-expand-icon').click();
  expect(control.requests.some(item => item.path?.startsWith('/api/v1/jobs/'))).toBe(false);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect.poll(() => control.requests.some(item => item.path?.includes('category=job&limit=50&offset=50'))).toBe(true);
});
