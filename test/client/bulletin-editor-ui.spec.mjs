import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

let control;

test.beforeEach(async ({ page }) => {
  control = await installNativeMock(page);
});

async function openBulletin(page) {
  await page.goto('/#bulletins');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日报' }).click();
  const editor = page.getByLabel('通报 HTML 源码');
  await expect(editor).toBeVisible();
  return editor;
}

test('Monaco 格式化嵌入源码并用 Ctrl+S 保存当前草稿', async ({ page }) => {
  const editor = await openBulletin(page);
  const source = '<!doctype html><html><head><style>body{color:red}</style></head><body><main>快捷键保存</main><script>const value={a:1,b:[2,3]};</script></body></html>';
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(source);

  await page.keyboard.press('Shift+Alt+F');
  await expect(page.getByText('HTML、CSS 和 JavaScript 已格式化')).toBeVisible();

  const putsBefore = control.requests.filter(request => request.command === 'api_request' && request.method === 'PUT').length;
  await page.keyboard.press('Control+S');
  await expect.poll(() => control.requests.filter(request => request.command === 'api_request' && request.method === 'PUT').length).toBe(putsBefore + 1);

  const saved = control.configs.get('daily-bulletin');
  expect(saved.body.html).toContain('color: red;');
  expect(saved.body.html).toContain('const value = { a: 1, b: [2, 3] };');
  expect(saved.body.html).toContain('<main>快捷键保存</main>');
});

test('数据源测试只列出已绑定定义并携带当前筛选参数', async ({ page }) => {
  const bulletin = control.configs.get('daily-bulletin');
  control.configs.set('daily-bulletin', {
    ...bulletin,
    body: {
      ...bulletin.body,
      parameters: [{ key: 'city', label: '地市', type: 'text', defaultValue: '贵阳' }],
    },
  });
  control.configs.set('unbound-query', {
    ...control.configs.get('daily-query'),
    id: 'unbound-query',
    name: '未绑定查询',
  });

  await openBulletin(page);
  const sourceSelect = page.getByLabel('测试数据源');
  await expect(sourceSelect.locator('xpath=..')).toContainText('权益明细取数');
  await sourceSelect.locator('xpath=../..').click();
  const visibleOptions = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content');
  await expect(visibleOptions.filter({ hasText: '权益明细取数' })).toBeVisible();
  await expect(visibleOptions.filter({ hasText: '未绑定查询' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const city = page.locator('.rd-config-preview .rd-config-param').filter({ hasText: '地市' }).getByRole('textbox');
  await city.fill('遵义');
  const requestsBefore = control.requests.filter(request => request.path === '/api/v1/resources/preview').length;
  await page.getByRole('button', { name: '测试', exact: true }).click();
  await expect(page.locator('.rd-config-source-result').getByRole('cell', { name: '贵阳' })).toBeVisible();
  await expect.poll(() => control.requests.filter(request => request.path === '/api/v1/resources/preview').length).toBe(requestsBefore + 1);

  const request = control.requests.filter(item => item.path === '/api/v1/resources/preview').at(-1);
  expect(request.body.definitionId).toBe('daily-query');
  expect(request.body.body.definitionIds).toEqual(['daily-query']);
  expect(request.body.params).toEqual({ city: '遵义' });
});

test('图片素材替换 Monaco 当前选区', async ({ page }) => {
  const editor = await openBulletin(page);
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: '示例图.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await expect(page.getByText('图片素材已插入光标位置')).toBeVisible();

  await page.keyboard.press('Control+S');
  await expect.poll(() => control.configs.get('daily-bulletin').version).toBe(2);
  const html = control.configs.get('daily-bulletin').body.html;
  expect(html).toMatch(/^<img src="data:image\/png;base64,/);
  expect(html).toContain('alt="示例图.png"');
  expect(html).not.toContain('权益日报');
});
