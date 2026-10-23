import { test, expect } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

test('installer starts only after verified download and explicit install confirmation', async ({ page }) => {
  const control = await installNativeMock(page);
  control.update = { available: true, currentVersion: '0.1.0', version: '0.2.0', size: 12345678, source: 'internal', configured: true };
  await page.goto('/');
  await page.getByRole('button', { name: /联调管理员/ }).hover();
  await page.getByRole('menuitem', { name: '检查更新' }).click();
  await expect(page.getByText('0.2.0', { exact: true })).toBeVisible();
  expect(control.requests.some(item => item.command === 'client_update_install')).toBe(false);
  await page.getByRole('button', { name: '下载并校验' }).click();
  await expect(page.getByText('安装包签名和完整性校验通过')).toBeVisible();
  expect(control.requests.some(item => item.command === 'client_update_install')).toBe(false);
  await page.getByRole('button', { name: '安装更新' }).click();
  await page.getByRole('button', { name: '启动安装' }).click();
  await expect.poll(() => control.requests.filter(item => item.command === 'client_update_install').length).toBe(1);
});

test('missing publisher verification disables installer download', async ({ page }) => {
  const control = await installNativeMock(page);
  control.update = { available: true, currentVersion: '0.1.0', version: '0.2.0', configured: false };
  await page.goto('/');
  await page.getByRole('button', { name: /联调管理员/ }).hover();
  await page.getByRole('menuitem', { name: '检查更新' }).click();
  await expect(page.getByText('发布验证未配置，暂不能安装更新')).toBeVisible();
  await expect(page.getByRole('button', { name: '下载并校验' })).toBeDisabled();
});

test('macOS GitHub update opens the disk image only after confirmation', async ({ page }) => {
  const control = await installNativeMock(page);
  control.update = { available: true, currentVersion: '0.1.1', version: '0.2.0', size: 12345678, source: 'github', platform: 'macos', arch: 'arm64', configured: true };
  await page.goto('/');
  await page.getByRole('button', { name: /联调管理员/ }).hover();
  await page.getByRole('menuitem', { name: '检查更新' }).click();
  await expect(page.getByText('GitHub Releases', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下载并校验' }).click();
  await expect(page.getByText('安装包签名和完整性校验通过')).toBeVisible();
  await page.getByRole('button', { name: '安装更新' }).click();
  await expect(page.getByText(/打开磁盘映像后，请退出客户端/)).toBeVisible();
  expect(control.requests.some(item => item.command === 'client_update_install')).toBe(false);
  await page.getByRole('button', { name: '打开安装包' }).click();
  await expect.poll(() => control.requests.filter(item => item.command === 'client_update_install').length).toBe(1);
});
