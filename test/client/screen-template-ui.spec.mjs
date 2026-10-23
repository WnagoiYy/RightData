import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';

const template = new URL('../../client/screen-template/', import.meta.url);
const [htmlSource, css, script] = await Promise.all([
  readFile(new URL('index.html', template), 'utf8'),
  readFile(new URL('screen.css', template), 'utf8'),
  readFile(new URL('screen.js', template), 'utf8'),
]);
const html = htmlSource.replace(/\s*<link[^>]+screen\.css[^>]*>/i, '').replace(/\s*<script[^>]+screen\.js[^>]*><\/script>/i, '');

function inlineScript(source) {
  return source.replace(/<\/script/gi, '<\\/script');
}

test('大屏模板只使用相对资源并通过容器查询桥接渲染', async ({ page }) => {
  assert.match(htmlSource, /href="\.\/screen\.css"/);
  assert.match(htmlSource, /src="\.\/screen\.js"/);
  assert.doesNotMatch(`${htmlSource}\n${script}`, /https?:\/\/|authorization|bearer|token/i);

  await page.goto('/');
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    window.__screenQueries = [];
    window.rightData = {
      query: async (definitionId, params) => {
        window.__screenQueries.push({ definitionId, params });
        const rows = [
          { 地市: '贵阳', 产品: '权益 A', 金额: '1280.5' },
          { 地市: '遵义', 产品: '权益 B', 金额: '960' },
        ];
        return { fields: [{ name: '地市' }, { name: '产品' }, { name: '金额' }], rows, total: 8 };
      },
    };
  });
  await page.addScriptTag({ type: 'module', content: script });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rightdata:init')));

  await expect(page.locator('#row-count')).toHaveText('2');
  await expect(page.locator('#amount-total')).toHaveText('2,240.5');
  await expect(page.locator('#query-total')).toHaveText('8');
  await expect(page.locator('tbody')).toContainText('权益 A');
  await expect(page.locator('#status')).toHaveText('已更新');

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rightdata:params', { detail: { city: '遵义' } })));
  await expect(page.locator('#city')).toHaveValue('遵义');
  await expect.poll(() => page.evaluate(() => window.__screenQueries.at(-1))).toEqual({ definitionId: 'replace-with-bound-definition-id', params: { city: '遵义' } });
});

test('只渲染最新查询并精确汇总大额小数', async ({ page }) => {
  await page.goto('/');
  await page.setContent(html);
  await page.evaluate(() => {
    window.__screenResolvers = [];
    window.rightData = {
      query: (_definitionId, params) => new Promise((resolve, reject) => window.__screenResolvers.push({ params, resolve, reject })),
    };
  });
  await page.addScriptTag({ type: 'module', content: script });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('rightdata:init'));
    window.dispatchEvent(new CustomEvent('rightdata:params', { detail: { city: '遵义' } }));
  });
  await expect.poll(() => page.evaluate(() => window.__screenResolvers.length)).toBe(2);
  await page.evaluate(() => window.__screenResolvers[1].resolve({
    fields: [{ name: '地市' }, { name: '金额' }],
    rows: [{ 地市: '遵义', 金额: '9007199254740993.12' }, { 地市: '遵义', 金额: '0.08' }],
    total: 2,
  }));
  await expect(page.locator('#amount-total')).toHaveText('9,007,199,254,740,993.2');
  await expect(page.locator('#status')).toHaveText('已更新');
  await page.evaluate(() => window.__screenResolvers[0].resolve({
    fields: [{ name: '地市' }, { name: '金额' }],
    rows: [{ 地市: '贵阳', 金额: '1' }],
    total: 1,
  }));
  await expect(page.locator('#amount-total')).toHaveText('9,007,199,254,740,993.2');
  await expect(page.locator('tbody')).toContainText('遵义');
});

test('表格截断有提示且查询失败会清除旧结果', async ({ page }) => {
  await page.goto('/');
  await page.setContent(html);
  await page.evaluate(() => {
    let request = 0;
    window.rightData = {
      query: async () => {
        request += 1;
        if (request === 2) throw new Error('连接中断');
        const rows = Array.from({ length: 101 }, (_, index) => ({ 序号: index + 1, 金额: '1' }));
        return { fields: [{ name: '序号' }, { name: '金额' }], rows, total: rows.length };
      },
    };
  });
  await page.addScriptTag({ type: 'module', content: script });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rightdata:init')));
  await expect(page.locator('#table-note')).toHaveText('仅显示前 100 条，共 101 条');
  await expect(page.locator('#table-body tr')).toHaveCount(100);
  await page.locator('#filters button').click();
  await expect(page.locator('#status')).toHaveText('连接中断');
  await expect(page.locator('#row-count')).toHaveText('--');
  await expect(page.locator('#amount-total')).toHaveText('--');
  await expect(page.locator('#table-note')).toBeHidden();
  await expect(page.locator('#table-body')).toHaveText('查询失败');
});

test('opaque sandbox 中查询按钮与 Enter 都显式触发查询', async ({ page }) => {
  assert.doesNotMatch(htmlSource, /<form\b/i);
  assert.match(htmlSource, /<button id="query" type="button">/i);

  const sandboxDocument = html.replace('</body>', `
    <script>
      window.__screenQueries = [];
      window.rightData = {
        query: async (definitionId, params) => {
          window.__screenQueries.push({ definitionId, params });
          const city = params.city || '全部';
          return {
            fields: [{ name: '地市' }, { name: '金额' }],
            rows: [{ 地市: city, 金额: '1.25' }],
            total: 1,
          };
        },
      };
    <\/script>
    <script type="module">${inlineScript(script)}<\/script>
  </body>`);

  await page.setContent('<iframe id="sandbox" sandbox="allow-scripts"></iframe>');
  await page.locator('#sandbox').evaluate((frame, content) => {
    frame.srcdoc = content;
  }, sandboxDocument);

  const frame = page.frameLocator('#sandbox');
  await frame.locator('#city').fill('贵阳');
  await frame.locator('#query').click();
  await expect(frame.locator('#table-body')).toContainText('贵阳');
  await expect.poll(() => frame.locator('body').evaluate(() => window.__screenQueries.length)).toBe(1);

  await frame.locator('#city').fill('遵义');
  await frame.locator('#city').press('Enter');
  await expect(frame.locator('#table-body')).toContainText('遵义');
  await expect.poll(() => frame.locator('body').evaluate(() => window.__screenQueries.at(-1))).toEqual({
    definitionId: 'replace-with-bound-definition-id',
    params: { city: '遵义' },
  });
});
