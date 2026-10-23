import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBulletinSource } from '../../client/src/features/config/bulletinFormatter.ts'

test('通报格式化同时处理 HTML、CSS 和 JavaScript', async () => {
  const source = '<!doctype html><html><head><style>body{color:red}</style></head><body><main>日报</main><script>const value={a:1,b:[2,3]};function read(){return value}</script></body></html>'
  const formatted = await formatBulletinSource(source)

  assert.match(formatted, /<main>日报<\/main>/)
  assert.match(formatted, /color: red;/)
  assert.match(formatted, /const value = \{ a: 1, b: \[2, 3\] \};/)
  assert.match(formatted, /return value;/)
})

test('通报格式化结果可重复执行且保持稳定', async () => {
  const once = await formatBulletinSource('<main><p>稳定格式</p></main>')
  const twice = await formatBulletinSource(once)
  assert.equal(twice, once)
})
