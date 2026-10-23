import { expect, test } from '../../client/node_modules/@playwright/test/index.mjs';
import { installNativeMock } from './mock-native.mjs';

let control;

test.beforeEach(async ({ page }) => {
  control = await installNativeMock(page);
  control.rows[0].金额 = '123456789012345678.90';
  control.rows[1].金额 = '0.10';
  control.rows[2].金额 = '0.20';
  control.rows[3].金额 = null;
  const report = control.configs.get('daily-report');
  control.configs.set('daily-report', {
    ...report,
    body: {
      ...report.body,
      parameters: [{ key: 'city', label: '地市筛选', type: 'text', defaultValue: '贵阳' }],
      parameterBindings: [{ parameterKey: 'city', queryParameterKey: 'region' }],
      columns: [
        { key: '编号', title: '编号', visible: false },
        { key: '地市', title: '地市', visible: true },
        { key: '产品', title: '产品', visible: true },
        { key: '金额', title: '金额', visible: true, format: 'number', decimals: 2, unit: '元', summary: 'avg', align: 'right' },
      ],
      defaultSorts: [{ key: '金额', direction: 'descend' }],
      drilldowns: [{ triggerField: '地市', targetResourceId: 'daily-board', parameterMappings: [{ sourceField: '地市', targetParameter: 'targetCity' }] }],
      maintenance: {
        definitionId: 'daily-query', datasetId: 'rights-db', table: '权益明细', keyFields: ['编号'],
        writableFields: ['编号', '地市', '产品', '金额'], allowInsert: true, allowUpdate: true, allowDelete: true,
      },
    },
  });
});

test('报表应用参数映射、可见列、精确汇总、多列默认排序和安全更新', async ({ page }) => {
  await page.goto('/#resource:daily-menu');
  const table = page.locator('.rd-config-data-surface table').first();
  await expect(table.getByRole('columnheader', { name: '编号' })).toHaveCount(0);
  await expect(table.getByText('123,456,789,012,345,678.90元')).toBeVisible();
  await expect(page.getByText('全量平均：41,152,263,004,115,226.40元')).toBeVisible();
  await expect(table.locator('tbody tr:not(.ant-table-measure-row)').first()).toContainText('贵阳');

  await expect.poll(() => control.requests.filter((item) => item.path === '/api/v1/resources/daily-report/execute').at(-1)?.body?.params).toEqual({ region: '贵阳' });

  await table.getByRole('button', { name: '编辑' }).first().click();
  const dialog = page.getByRole('dialog', { name: '编辑记录' });
  await dialog.getByLabel('产品').fill('权益产品 Z');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => control.requests.filter((item) => item.path?.endsWith('/records:mutate')).length).toBe(1);
  const mutation = control.requests.filter((item) => item.path?.endsWith('/records:mutate')).at(-1);
  expect(mutation.idempotencyKey).toBeTruthy();
  expect(mutation.body.operations[0].filter).toEqual({ logic: 'and', rules: [{ field: '编号', op: 'eq', value: '9007199254740993' }] });
  expect(mutation.body.operations[0].values).not.toHaveProperty('编号');
});

test('报表字段钻取通过目标资源授权端点并可返回', async ({ page }) => {
  await page.goto('/#resource:daily-menu');
  await page.getByRole('button', { name: '贵阳' }).click();
  await expect.poll(() => control.requests.some((item) => item.path === '/api/v1/resources/daily-board')).toBe(true);
  await expect.poll(() => control.requests.filter((item) => item.path === '/api/v1/resources/daily-board/execute').at(-1)?.body?.params).toEqual({ targetCity: '贵阳' });
  await page.getByRole('button', { name: '返回' }).click();
  await expect(page.getByRole('button', { name: '贵阳' })).toBeVisible();
});

test('报表参数标识逐字编辑保持焦点并迁移查询参数绑定', async ({ page }) => {
  await page.goto('/#reports');
  await page.locator('.rd-config-name-button').filter({ hasText: '权益日常明细' }).click();
  const keyInput = page.getByLabel('参数标识');
  await keyInput.fill('cityCode');
  await expect(keyInput).toBeFocused();
  await expect(page.getByLabel('默认值 地市筛选')).toHaveValue('贵阳');
  await expect(page.getByLabel('查询参数 地市筛选')).toHaveValue('region');
});
