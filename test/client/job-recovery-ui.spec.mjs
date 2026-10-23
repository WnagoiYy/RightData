import { test, expect } from '../../client/node_modules/@playwright/test/index.mjs'
import { installNativeMock } from './mock-native.mjs'

const scope = 'test-instance:test-user'
const storageKey = (kind, targetScope = scope) => `rightdata:job-history:v1:${encodeURIComponent(targetScope)}:${encodeURIComponent(kind)}`
const reference = (jobId, kind, label) => ({ jobId, kind, label, createdAt: '2026-10-23T02:00:00Z' })
const job = (id, kind, state, result) => ({
  id,
  kind,
  datasetId: 'rights-db',
  state,
  progress: { phase: state === 'succeeded' ? 'complete' : state, percent: state === 'succeeded' ? 100 : undefined },
  result,
  createdAt: '2026-10-23T02:00:00Z',
  updatedAt: '2026-10-23T02:00:01Z',
  expiresAt: '2026-10-24T02:00:00Z',
})

test('export task reference survives reload and remains isolated by instance and user scope', async ({ page }) => {
  const control = await installNativeMock(page)
  control.jobs.set('export-test', job('export-test', 'export', 'succeeded', { name: '权益明细.ndjson', totalRows: 4 }))
  await page.addInitScript(({ foreignKey, foreignReference }) => {
    localStorage.setItem(foreignKey, JSON.stringify([foreignReference]))
  }, {
    foreignKey: storageKey('export', 'another-instance:test-user'),
    foreignReference: reference('foreign-export', 'export', '其他实例导出'),
  })

  await page.goto('/#data')
  await page.getByRole('button', { name: /全量导出/ }).click()
  await expect(page.getByRole('button', { name: /保存 Excel/ })).toBeVisible()

  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey('export'))
  expect(stored).toHaveLength(1)
  expect(stored[0]).toEqual({
    jobId: 'export-test',
    kind: 'export',
    label: '权益明细',
    createdAt: expect.any(String),
  })
  expect(Object.keys(stored[0]).sort()).toEqual(['createdAt', 'jobId', 'kind', 'label'])

  control.requests.length = 0
  await page.reload()
  await expect(page.getByRole('button', { name: /保存 Excel/ })).toBeVisible()
  await expect(page.getByText(/^权益明细 · 2026/)).toBeVisible()
  expect(control.requests.some((item) => item.path === '/api/v1/jobs/export-test')).toBe(true)
  expect(control.requests.some((item) => item.path === '/api/v1/jobs/foreign-export')).toBe(false)
})

test('expired export remains in recent tasks and cannot be downloaded', async ({ page }) => {
  const control = await installNativeMock(page)
  control.jobs.set('expired-export', job('expired-export', 'export', 'expired'))
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify([value]))
  }, { key: storageKey('export'), value: reference('expired-export', 'export', '历史导出') })

  await page.goto('/#data')
  await expect(page.getByText('expired', { exact: true })).toBeVisible()
  await expect(page.getByText(/^历史导出 · 2026/)).toBeVisible()
  await expect(page.getByRole('button', { name: /保存 Excel/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'NDJSON' })).toHaveCount(0)
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey('export'))
  expect(stored.map((item) => item.jobId)).toContain('expired-export')
})

test('manual forbidden task clears the shown result and reports a short error', async ({ page }) => {
  const control = await installNativeMock(page)
  control.jobs.set('owned-export', job('owned-export', 'export', 'succeeded', { name: '已有结果.ndjson', totalRows: 1 }))
  control.jobErrors.set('forbidden-export', { status: 403, code: 'forbidden', message: '不能查看其他用户的任务' })
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify([value]))
  }, { key: storageKey('export'), value: reference('owned-export', 'export', '已有结果') })

  await page.goto('/#data')
  await expect(page.getByRole('button', { name: /保存 Excel/ })).toBeVisible()
  await page.getByLabel('导出任务 ID').fill('forbidden-export')
  await page.getByRole('button', { name: '恢复' }).click()
  await expect(page.getByText('无权读取该任务')).toBeVisible()
  await expect(page.getByRole('button', { name: /保存 Excel/ })).toHaveCount(0)
  await expect(page.getByText('owned-export')).toHaveCount(0)
})

test('a slower previous recovery cannot overwrite a newer selected task', async ({ page }) => {
  const control = await installNativeMock(page)
  control.jobs.set('slow-export', job('slow-export', 'export', 'succeeded', { name: '旧任务.ndjson' }))
  control.jobs.set('fast-export', job('fast-export', 'export', 'succeeded', { name: '新任务.ndjson' }))
  let releaseSlow
  control.jobGates.set('slow-export', new Promise((resolve) => { releaseSlow = resolve }))
  control.jobDelays.set('fast-export', 20)
  await page.addInitScript(({ key, values }) => {
    localStorage.setItem(key, JSON.stringify(values))
  }, { key: storageKey('export'), values: [reference('slow-export', 'export', '旧任务'), reference('fast-export', 'export', '新任务')] })

  await page.goto('/#data')
  await expect.poll(() => control.requests.some((item) => item.path === '/api/v1/jobs/slow-export')).toBe(true)
  await page.getByLabel('导出最近任务').click()
  await page.locator('.ant-select-item-option').filter({ hasText: '新任务' }).click()
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-job-id', 'fast-export')
  expect(control.requests.some((item) => item.path === '/api/v1/jobs/fast-export')).toBe(true)
  await expect.poll(() => control.jobCompletions).toContain('fast-export')
  releaseSlow()
  await expect.poll(() => control.jobCompletions).toContain('slow-export')
  await expect.poll(() => page.evaluate(() => window.__rightdataTestResponses)).toContain('slow-export')
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-job-id', 'fast-export')
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-state', 'succeeded')
})

test('an in-flight poll from the old task cannot overwrite a new manual selection', async ({ page }) => {
  const control = await installNativeMock(page)
  control.jobs.set('polling-export', job('polling-export', 'export', 'running'))
  control.jobs.set('replacement-export', job('replacement-export', 'export', 'succeeded', { name: '替换任务.ndjson' }))

  await page.goto('/#data')
  await page.getByLabel('导出任务 ID').fill('polling-export')
  await page.getByTestId('export-job-recover').click()
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-job-id', 'polling-export')
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-state', 'running')

  const previousRequests = control.requests.filter((item) => item.path === '/api/v1/jobs/polling-export').length
  control.jobDelays.set('polling-export', 700)
  control.jobs.set('polling-export', job('polling-export', 'export', 'succeeded', { name: '旧轮询.ndjson' }))
  await expect.poll(() => control.requests.filter((item) => item.path === '/api/v1/jobs/polling-export').length).toBeGreaterThan(previousRequests)

  await page.getByLabel('导出任务 ID').fill('replacement-export')
  await page.getByTestId('export-job-recover').click()
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-job-id', 'replacement-export')
  await page.waitForTimeout(850)
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-job-id', 'replacement-export')
  await expect(page.getByTestId('export-job-status')).toHaveAttribute('data-state', 'succeeded')
})

test('import task restores persisted result counts after page entry', async ({ page }) => {
  const control = await installNativeMock(page)
  control.jobs.set('import-history', job('import-history', 'import', 'succeeded', {
    insertedRows: 2,
    updatedRows: 1,
    skippedRows: 3,
  }))
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify([value]))
  }, { key: storageKey('import'), value: reference('import-history', 'import', '权益明细') })

  await page.goto('/#import')
  await expect(page.getByText('import-history')).toBeVisible()
  await expect(page.locator('.rd-job-counts')).toContainText('新增 2')
  await expect(page.locator('.rd-job-counts')).toContainText('更新 1')
  await expect(page.locator('.rd-job-counts')).toContainText('跳过 3')
})

test('backup submission stores a limited reference and restores it after reload', async ({ page }) => {
  const control = await installNativeMock(page)
  control.jobs.set('backup-test', job('backup-test', 'backup', 'succeeded', { name: 'rights-backup.duckdb' }))

  await page.goto('/#databases')
  await page.locator('.rd-database-table').getByRole('button', { name: /备份$/ }).click()
  await expect(page.getByTestId('backup-job-status')).toHaveAttribute('data-job-id', 'backup-test')
  await expect(page.getByTestId('backup-job-status')).toHaveAttribute('data-state', 'succeeded')

  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey('backup'))
  expect(stored).toEqual([{
    jobId: 'backup-test',
    kind: 'backup',
    label: 'rights.duckdb',
    createdAt: expect.any(String),
  }])

  await page.reload()
  await expect(page.getByTestId('backup-job-status')).toHaveAttribute('data-job-id', 'backup-test')
  await expect(page.getByTestId('backup-job-status')).toHaveAttribute('data-state', 'succeeded')
})
