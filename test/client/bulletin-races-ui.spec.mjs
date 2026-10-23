import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

async function holdFirstPreview(page) {
  await page.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    let count = 0;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args);
      if (command !== 'api_request' || args?.request?.path !== '/api/v1/resources/preview') return result;
      const number = ++count;
      result.data.data.data = { fields: [{ name: 'marker' }], rows: [{ marker: number === 1 ? '旧结果' : '新结果' }], total: 1 };
      if (number === 1) await new Promise(resolve => { window.__releasePreview = resolve; });
      return result;
    };
  });
}

test('更换通报源码后旧文档的迟到查询不能覆盖新文档', async ({ page }) => {
  const control = await installNativeMock(page);
  const bulletin = control.configs.get('daily-bulletin');
  const source = version => `<main data-version="${version}"><div id="result">等待查询</div><script>window.rightData.query('daily-query').then(data => document.querySelector('#result').textContent = data.rows[0].marker)</script></main>`;
  control.configs.set(bulletin.id, { ...bulletin, body: { ...bulletin.body, html: source('old') } });
  await holdFirstPreview(page);
  await page.goto('/#bulletins');
  await page.locator('.rd-config-name-button').filter({ hasText: bulletin.name }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__releasePreview)).toBe('function');
  const editor = page.getByLabel('通报 HTML 源码');
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(source('new'));
  const result = page.frameLocator('iframe[title="通报内容"]').locator('#result');
  await expect(result).toHaveText('新结果');
  await result.evaluate(() => {
    window.__lateResultSeen = false;
    window.addEventListener('message', event => { if (event.data?.type === 'rightdata:result') window.__lateResultSeen = true; });
  });
  await page.evaluate(() => window.__releasePreview());
  await expect.poll(() => result.evaluate(() => window.__lateResultSeen)).toBe(true);
  await expect(result).toHaveText('新结果');
});

test('修改筛选参数后不再展示先前数据源测试的迟到结果', async ({ page }) => {
  const control = await installNativeMock(page);
  const bulletin = control.configs.get('daily-bulletin');
  control.configs.set(bulletin.id, { ...bulletin, body: { ...bulletin.body, html: '<main>预览</main>', parameters: [{ key: 'city', label: '地市', type: 'text', defaultValue: '贵阳' }] } });
  await holdFirstPreview(page);
  await page.goto('/#bulletins');
  await page.locator('.rd-config-name-button').filter({ hasText: bulletin.name }).click();
  await page.getByRole('button', { name: '测试', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__releasePreview)).toBe('function');
  const city = page.locator('.rd-config-preview .rd-config-param').filter({ hasText: '地市' }).getByRole('textbox');
  await city.fill('遵义');
  await page.evaluate(() => window.__releasePreview());
  await expect(page.locator('.rd-config-source-result')).toHaveCount(0);
  await page.getByRole('button', { name: '测试', exact: true }).click();
  await expect(page.locator('.rd-config-source-result')).toContainText('新结果');
});
