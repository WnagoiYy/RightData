import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from '../../client/node_modules/xlsx/dist/xlsx.full.min.js'
import {
  reportCsvBytes,
  reportExportAvailability,
  reportExportColumns,
  reportExportFileName,
  reportXlsxBytes,
} from '../../client/src/features/config/report-export'

const result = {
  fields: [{ name: '编号' }, { name: '备注' }, { name: '金额' }],
  rows: [
    { 编号: '9007199254740993', 备注: '含,逗号', 金额: '123456789012345678.90' },
    { 编号: '9007199254740994', 备注: '含"引号"', 金额: null },
  ],
  total: 2,
}

test('只有可核验为完整的已加载结果才允许本地数据导出', () => {
  assert.deepEqual(reportExportAvailability(result), { available: true })
  assert.equal(reportExportAvailability({ ...result, total: 3 }).available, false)
  assert.equal(reportExportAvailability({ ...result, truncated: true }).available, false)
  assert.match(reportExportAvailability({ ...result, total: 3 }).message ?? '', /仅加载 2\/3 条/)
})

test('CSV 使用 UTF-8 BOM、RFC 4180 转义并保留大整数和小数文本', () => {
  const columns = reportExportColumns(result)
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(reportCsvBytes(result, columns))
  assert.ok(csv.startsWith('\uFEFF编号,备注,金额\r\n'))
  assert.match(csv, /9007199254740993,"含,逗号",123456789012345678\.90/)
  assert.match(csv, /9007199254740994,"含""引号""",/)
})

test('XLSX 将精确数值文本保持为字符串并生成安全文件名', () => {
  const columns = reportExportColumns(result)
  const bytes = reportXlsxBytes(result, columns, '权益/日报')
  const workbook = XLSX.read(bytes, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  assert.equal(workbook.SheetNames[0], '权益_日报')
  assert.equal(sheet.A2.t, 's')
  assert.equal(sheet.A2.v, '9007199254740993')
  assert.equal(sheet.C2.t, 's')
  assert.equal(sheet.C2.v, '123456789012345678.90')
  assert.equal(reportExportFileName('权益:日报 ', 'xlsx'), '权益-日报.xlsx')
})

test('配置列只导出可见且真实存在的字段', () => {
  assert.deepEqual(reportExportColumns(result, [
    { key: '编号', title: '业务编号', visible: true },
    { key: '备注', title: '备注', visible: false },
  ]), [{ key: '编号', title: '业务编号' }])
  assert.throws(() => reportExportColumns(result, [{ key: '不存在', title: '缺失列' }]), /查询结果缺少报表字段/)
  assert.throws(() => reportExportColumns(result, [{ key: '编号', title: '编号', visible: false }]), /没有可导出的显示列/)
})
