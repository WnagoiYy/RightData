const SCREEN_CONFIG = Object.freeze({
  definitionId: 'replace-with-bound-definition-id',
  amountField: '金额',
  mock: new URLSearchParams(location.search).get('mock') === '1' && ['localhost', '127.0.0.1'].includes(location.hostname),
})

const elements = {
  city: document.querySelector('#city'),
  query: document.querySelector('#query'),
  status: document.querySelector('#status'),
  rowCount: document.querySelector('#row-count'),
  amountTotal: document.querySelector('#amount-total'),
  queryTotal: document.querySelector('#query-total'),
  tableNote: document.querySelector('#table-note'),
  head: document.querySelector('#table-head'),
  body: document.querySelector('#table-body'),
}

let currentParams = {}
let querySequence = 0

function text(value) {
  if (value === null || value === undefined || value === '') return '--'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function decimal(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return undefined
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/)
  if (!match) return undefined
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return undefined
  let digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, '')
  let scale = fraction.length - exponent
  if (scale < 0) {
    digits += '0'.repeat(-scale)
    scale = 0
  }
  const units = BigInt(digits || '0') * (match[1] === '-' ? -1n : 1n)
  return { units, scale }
}

function amountTotal(rows) {
  let units = 0n
  let scale = 0
  for (const row of rows) {
    const value = decimal(row[SCREEN_CONFIG.amountField])
    if (value === undefined) return undefined
    if (value === null) continue
    if (value.scale > scale) {
      units *= 10n ** BigInt(value.scale - scale)
      scale = value.scale
    }
    units += value.units * (10n ** BigInt(scale - value.scale))
  }
  return { units, scale }
}

function formatDecimal(value, maximumFractionDigits = 2) {
  let units = value.units
  let scale = value.scale
  if (scale > maximumFractionDigits) {
    const divisor = 10n ** BigInt(scale - maximumFractionDigits)
    const negative = units < 0n
    let magnitude = negative ? -units : units
    const quotient = magnitude / divisor
    const remainder = magnitude % divisor
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n)
    units = negative ? -magnitude : magnitude
    scale = maximumFractionDigits
  }
  const negative = units < 0n
  let digits = String(negative ? -units : units).padStart(scale + 1, '0')
  const integer = (scale ? digits.slice(0, -scale) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, '') : ''
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`
}

function renderTable(result) {
  const fields = Array.isArray(result.fields) ? result.fields.map((field) => field.name).filter(Boolean) : []
  const rows = Array.isArray(result.rows) ? result.rows : []
  elements.head.replaceChildren()
  elements.body.replaceChildren()
  elements.tableNote.hidden = rows.length <= 100
  elements.tableNote.textContent = rows.length > 100 ? `仅显示前 100 条，共 ${rows.length.toLocaleString('zh-CN')} 条` : ''
  if (!fields.length || !rows.length) {
    const cell = document.createElement('td')
    cell.className = 'empty'
    cell.textContent = '暂无数据'
    const row = document.createElement('tr')
    row.append(cell)
    elements.body.append(row)
    return
  }
  const headerRow = document.createElement('tr')
  for (const field of fields) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = field
    headerRow.append(cell)
  }
  elements.head.append(headerRow)
  for (const item of rows.slice(0, 100)) {
    const row = document.createElement('tr')
    for (const field of fields) {
      const cell = document.createElement('td')
      cell.textContent = text(item[field])
      row.append(cell)
    }
    elements.body.append(row)
  }
}

function render(result) {
  const rows = Array.isArray(result.rows) ? result.rows : []
  const amount = amountTotal(rows)
  elements.rowCount.textContent = rows.length.toLocaleString('zh-CN')
  elements.amountTotal.textContent = amount ? formatDecimal(amount) : '--'
  elements.queryTotal.textContent = Number(result.total ?? rows.length).toLocaleString('zh-CN')
  renderTable(result)
  return amount ? '' : '金额字段含非数值，无法汇总'
}

function clearResult(message) {
  elements.rowCount.textContent = '--'
  elements.amountTotal.textContent = '--'
  elements.queryTotal.textContent = '--'
  elements.tableNote.hidden = true
  elements.tableNote.textContent = ''
  elements.head.replaceChildren()
  elements.body.replaceChildren()
  const cell = document.createElement('td')
  cell.className = 'empty'
  cell.textContent = message
  const row = document.createElement('tr')
  row.append(cell)
  elements.body.append(row)
}

function localMock(params) {
  const allRows = [
    { 地市: '贵阳', 产品: '本地样例 A', 金额: 1280.5 },
    { 地市: '遵义', 产品: '本地样例 B', 金额: 960 },
    { 地市: '毕节', 产品: '本地样例 C', 金额: 2310.8 },
  ]
  const rows = params.city ? allRows.filter((row) => row.地市.includes(String(params.city))) : allRows
  return Promise.resolve({ fields: [{ name: '地市' }, { name: '产品' }, { name: '金额' }], rows, total: rows.length })
}

async function query() {
  const sequence = ++querySequence
  const params = { ...currentParams }
  const city = elements.city.value.trim()
  if (city) params.city = city
  else delete params.city
  elements.status.textContent = SCREEN_CONFIG.mock ? '本地 Mock 查询中' : '查询中'
  try {
    const result = SCREEN_CONFIG.mock
      ? await localMock(params)
      : await window.rightData.query(SCREEN_CONFIG.definitionId, params)
    if (sequence !== querySequence) return
    const warning = render(result)
    elements.status.textContent = warning || (SCREEN_CONFIG.mock ? '本地 Mock 数据' : '已更新')
  } catch (error) {
    if (sequence !== querySequence) return
    clearResult('查询失败')
    elements.status.textContent = error instanceof Error ? error.message : '查询失败'
  }
}

elements.query.addEventListener('click', () => {
  void query()
})

elements.city.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  void query()
})

window.addEventListener('rightdata:params', (event) => {
  currentParams = event.detail && typeof event.detail === 'object' ? event.detail : {}
  elements.city.value = typeof currentParams.city === 'string' ? currentParams.city : ''
  void query()
})

window.addEventListener('rightdata:init', () => void query())

if (SCREEN_CONFIG.mock) void query()
else if (!window.rightData?.query) elements.status.textContent = '请在大屏容器中打开'
