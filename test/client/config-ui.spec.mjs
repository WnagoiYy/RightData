import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

let control;

test.beforeEach(async ({ page }) => {
  control = await installNativeMock(page);
});

test('配置编辑、真实预览和冲突处理保留本地草稿', async ({ page }) => {
  await page.goto('/#reports');
  const report = page.locator('.rd-config-name-button').filter({ hasText: '权益日常明细' });
  await expect(report).toBeVisible();
  await report.click();
  await expect(page.getByText('预览', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '贵阳' })).toBeVisible();

  const current = control.configs.get('daily-report');
  control.configs.set('daily-report', { ...current, name: '服务器日报', version: current.version + 1 });
  const name = page.getByLabel('配置名称');
  await name.fill('冲突草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('服务器版本已更新，本地草稿仍已保留。')).toBeVisible();
  await expect(name).toHaveValue('冲突草稿');
  await page.getByRole('button', { name: '加载服务器版本' }).click();
  await expect(name).toHaveValue('服务器日报');
});

test('报表图片通过桌面保存桥导出', async ({ page }) => {
  await page.goto('/#reports');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日常明细' }).click();
  await expect(page.getByRole('cell', { name: '贵阳' })).toBeVisible();
  await page.getByRole('button', { name: '导出 PNG' }).dispatchEvent('click');
  await expect.poll(() => control.saves.length).toBe(1);
  expect(control.saves[0].suggestedName).toBe('权益日常明细.png');
  expect(control.saves[0].bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});

test('报表支持排序、行数汇总和完整当前结果数据导出', async ({ page }) => {
  await page.goto('/#reports');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日常明细' }).click();
  const table = page.locator('.rd-config-data-surface table').first();
  await expect(table.getByRole('cell', { name: '贵阳' })).toBeVisible();
  await expect(page.getByText('当前页 4 条 · 已加载 4 条 · 查询总数 4 条')).toBeVisible();

  await table.getByRole('columnheader', { name: /金额/ }).click();
  await expect(table.locator('tbody tr:not(.ant-table-measure-row)').first()).toContainText('六盘水');

  await page.getByRole('button', { name: '导出已加载 CSV' }).click();
  await expect.poll(() => control.saves.length).toBe(1);
  expect(control.saves[0].suggestedName).toBe('权益日常明细.csv');
  const csv = Buffer.from(control.saves[0].bytes).toString('utf8');
  expect(csv).toContain('\uFEFF编号,地市,产品,金额\r\n');
  expect(csv).toContain('9007199254740993,贵阳,权益产品 A,1280.50');

  await page.getByRole('button', { name: '导出已加载 XLSX' }).click();
  await expect.poll(() => control.saves.length).toBe(2);
  expect(control.saves[1].suggestedName).toBe('权益日常明细.xlsx');
  expect(control.saves[1].bytes.slice(0, 4)).toEqual([80, 75, 3, 4]);
});

test('报表结果未完整加载时拒绝把当前页作为完整数据导出', async ({ page }) => {
  control.queryTotal = 12;
  await page.goto('/#reports');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日常明细' }).click();
  await expect(page.getByText('当前结果仅加载 4/12 条。本地数据导出已停用，请到数据工作台执行全量导出。')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出已加载 CSV' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出已加载 XLSX' })).toBeDisabled();
  expect(control.saves).toHaveLength(0);
});

test('普通资源支持进入全屏并用 Esc 返回', async ({ page }) => {
  await page.addInitScript(() => {
    let activeFullscreenElement = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => activeFullscreenElement });
    HTMLElement.prototype.requestFullscreen = async function requestFullscreen() {
      activeFullscreenElement = this;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    document.exitFullscreen = async () => {
      activeFullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
  });
  await page.goto('/#resource:daily-menu');
  await expect(page.getByRole('cell', { name: '贵阳' })).toBeVisible();
  await page.getByRole('button', { name: '进入全屏' }).click();
  await expect(page.getByRole('button', { name: '退出全屏' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('rd-resource-fullscreen'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '进入全屏' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test('看板截图可导出为 JPEG', async ({ page }) => {
  await page.goto('/#dashboards');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益运营看板' }).click();
  await expect(page.getByRole('cell', { name: '贵阳' })).toBeVisible();
  await page.getByRole('button', { name: '导出 JPEG' }).dispatchEvent('click');
  await expect.poll(() => control.saves.length).toBe(1);
  expect(control.saves[0].suggestedName).toBe('权益运营看板.jpg');
  expect(control.saves[0].bytes.slice(0, 3)).toEqual([255, 216, 255]);
});

test('普通资源查看只走资源授权端点并执行绑定查询', async ({ page }) => {
  await page.goto('/#resource:daily-menu');
  await expect(page.getByRole('cell', { name: '贵阳' })).toBeVisible();
  const requests = control.requests.filter(request => request.command === 'api_request');
  expect(requests.some(request => request.path === '/api/v1/resources/daily-report')).toBeTruthy();
  expect(requests.some(request => request.path === '/api/v1/resources/daily-report/execute')).toBeTruthy();
  expect(requests.some(request => /\/api\/v1\/configs\/[^/]+\/execute/.test(request.path))).toBeFalsy();
});

test('通报 iframe 保持 opaque sandbox、禁止联网并可导出图片', async ({ page }) => {
  await page.goto('/#bulletins');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日报' }).click();
  const frame = page.locator('iframe[title="通报内容"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const srcdoc = await frame.getAttribute('srcdoc');
  expect(srcdoc).toContain("connect-src 'none'");
  expect(srcdoc).toContain("frame-src 'none'");
  expect(srcdoc).not.toMatch(/token|authorization|tauri|api_request/i);
  await expect(frame.contentFrame().getByText('已加载 4 条记录')).toBeVisible();

  await page.getByRole('button', { name: '导出 JPEG' }).dispatchEvent('click');
  await expect.poll(() => control.saves.length).toBe(1);
  expect(control.saves[0].suggestedName).toBe('权益日报.jpg');
  expect(control.saves[0].bytes.slice(0, 3)).toEqual([255, 216, 255]);
});
