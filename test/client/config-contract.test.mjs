import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from '../../client/node_modules/typescript/lib/typescript.js'

const corePath = new URL('../../client/src/features/config/core.ts', import.meta.url)
const source = await readFile(corePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText
const core = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('配置与普通资源路径遵守服务端契约', () => {
  assert.equal(core.configListPath(), '/api/v1/configs')
  assert.equal(core.configListPath('h5'), '/api/v1/configs?kind=h5')
  assert.equal(core.configPath('日报/贵州', 7), '/api/v1/configs/%E6%97%A5%E6%8A%A5%2F%E8%B4%B5%E5%B7%9E?version=7')
  assert.equal(core.resourcePath('board/a'), '/api/v1/resources/board%2Fa')
  assert.equal(core.resourceExecutePath('board/a'), '/api/v1/resources/board%2Fa/execute')
  assert.equal(core.toServerKind('bulletin'), 'h5')
  assert.equal(core.toServerKind('query'), 'query')
  assert.equal(core.toServerKind('role'), 'role')
  assert.equal(core.toServerKind('screen'), 'screen')
  assert.equal(core.toWorkspaceKind('screen'), 'screen')
  assert.equal(core.normalizeResourceKind('screen'), 'screen')
})

test('资源策略只接受有效的字符串数组', () => {
  assert.deepEqual(core.policyOf({ enabled: true, permissions: ['report.read', '', 3], definitionIds: ['query-1', null] }), {
    enabled: true,
    permissions: ['report.read'],
    definitionIds: ['query-1'],
  })
  assert.deepEqual(core.policyOf(null), { enabled: false, permissions: [], definitionIds: [] })
})

test('新建资源默认保持草稿停用并包含完整策略字段', () => {
  for (const kind of ['report', 'dashboard', 'screen', 'bulletin']) {
    const body = core.emptyBody(kind)
    assert.equal(body.enabled, false)
    assert.deepEqual(body.permissions, [])
    assert.deepEqual(body.definitionIds, [])
  }
  assert.equal(core.emptyBody('menu').enabled, true)
  assert.equal(core.emptyBody('query').sql, 'SELECT 1 AS value')
})

test('通报文档使用不透明 sandbox 消息桥且禁止直接联网和嵌套内容', () => {
  const document = core.sandboxDocument('<main>通报</main>', 'test-channel')
  assert.match(document, /default-src 'none'/)
  assert.match(document, /connect-src 'none'/)
  assert.match(document, /frame-src 'none'/)
  assert.match(document, /object-src 'none'/)
  assert.match(document, /window\.rightData=Object\.freeze/)
  assert.doesNotMatch(document, /token|authorization|tauri|api_request/i)
  assert.match(document, /rightdata:query/)
  assert.match(document, /rightdata:capture/)
  assert.match(document, /rightdata:capture-result/)
})

test('权限失效识别覆盖 HTTP 状态与服务端错误码', () => {
  assert.equal(core.isAccessRevoked({ status: 401 }), true)
  assert.equal(core.isAccessRevoked({ statusCode: 403 }), true)
  assert.equal(core.isAccessRevoked({ code: 'resource_forbidden' }), true)
  assert.equal(core.isAccessRevoked({ status: 409, code: 'version_conflict' }), false)
})

test('普通 ResourceView 不导入或拼接管理配置执行路径', async () => {
  const view = await readFile(new URL('../../client/src/features/config/ResourceView.tsx', import.meta.url), 'utf8')
  assert.match(view, /resourcePath\(currentResourceId\)/)
  assert.match(view, /resourceExecutePath\(requestResourceId\)/)
  assert.doesNotMatch(view, /configPath|\/api\/v1\/configs|configs\/.+execute/)
})

