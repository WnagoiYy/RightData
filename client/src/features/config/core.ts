import type {
  BulletinBody,
  DashboardBody,
  MenuBody,
  ReportBody,
  RoleBody,
  QueryDefinitionBody,
  ResourceKind,
  ResourcePolicy,
  ScreenBody,
  ServerConfigKind,
  SharedConfig,
  WorkspaceKind,
} from './types'

export const CONFIG_KINDS: Exclude<WorkspaceKind, 'all'>[] = ['report', 'dashboard', 'screen', 'menu', 'bulletin', 'query', 'role']

export const KIND_LABELS: Record<WorkspaceKind, string> = {
  all: '全部配置',
  report: '报表',
  dashboard: '看板',
  screen: '大屏',
  menu: '菜单',
  bulletin: '通报',
  query: '查询定义',
  role: '角色配置',
}

export function toServerKind(kind: Exclude<WorkspaceKind, 'all'>): ServerConfigKind {
  return kind === 'bulletin' ? 'h5' : kind
}

export function toWorkspaceKind(kind: ServerConfigKind): WorkspaceKind {
  return kind === 'h5' ? 'bulletin' : kind
}

export function configListPath(kind?: ServerConfigKind): string {
  return `/api/v1/configs${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`
}

export function configPath(id: string, version?: number): string {
  const path = `/api/v1/configs/${encodeURIComponent(id)}`
  return version === undefined ? path : `${path}?version=${encodeURIComponent(String(version))}`
}

export function resourcePath(id: string): string {
  return `/api/v1/resources/${encodeURIComponent(id)}`
}

export function resourceExecutePath(id: string): string {
  return `${resourcePath(id)}/execute`
}

export function createId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${value}`
}

export function idempotencyKey(action: string, id: string): string {
  return `${action}:${id}:${createId('op')}`
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
}

export function policyOf(body: unknown): ResourcePolicy {
  const value = asObject(body)
  return {
    enabled: value.enabled === true,
    permissions: stringArray(value.permissions),
    definitionIds: stringArray(value.definitionIds),
  }
}

export function emptyBody(kind: Exclude<WorkspaceKind, 'all'>): ReportBody | DashboardBody | ScreenBody | MenuBody | BulletinBody | QueryDefinitionBody | RoleBody {
  if (kind === 'query') return { datasetId: '', sql: 'SELECT 1 AS value', permissions: [] }
  if (kind === 'role') return { description: '', permissions: [] }
  if (kind === 'menu') {
    return { enabled: true, permissions: [], parentId: '', order: 0, resourceId: '', resourceKind: '' }
  }
  if (kind === 'dashboard') {
    return { enabled: false, permissions: [], definitionIds: [], description: '', theme: 'light', refreshSeconds: 0, parameters: [], widgets: [] }
  }
  if (kind === 'screen') {
    return { enabled: false, permissions: [], definitionIds: [], parameters: [] }
  }
  if (kind === 'bulletin') {
    return {
      enabled: false,
      permissions: [],
      definitionIds: [],
      description: '',
      parameters: [],
      html: '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:32px;font-family:system-ui;color:#172033;background:#fff}h1{font-size:28px;margin:0 0 16px}.metric{font-size:40px;font-weight:700;color:#2458d3}</style></head><body><h1>数据通报</h1><div id="value" class="metric">--</div><script>window.addEventListener("rightdata:init",()=>{});</script></body></html>',
    }
  }
  return { enabled: false, permissions: [], definitionIds: [], description: '', primaryDefinitionId: '', parameters: [], columns: [], pageSize: 20 }
}

export function normalizeResourceKind(value: unknown): ResourceKind | '' {
  return value === 'report' || value === 'dashboard' || value === 'screen' || value === 'h5' ? value : ''
}

export function isConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: number; statusCode?: number; code?: string; message?: string }
  return value.status === 409 || value.statusCode === 409 || value.code === 'version_conflict' || /version|版本|冲突/i.test(value.message ?? '')
}

export function isAccessRevoked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: number; statusCode?: number; code?: string }
  return value.status === 401 || value.status === 403 || value.statusCode === 401 || value.statusCode === 403 || value.code === 'unauthenticated' || value.code === 'forbidden' || value.code === 'resource_forbidden'
}

export function formatError(error: unknown, fallback = '操作失败'): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object') {
    const value = error as { message?: string; error?: { message?: string } }
    return value.message ?? value.error?.message ?? fallback
  }
  return fallback
}

export function findLatest(items: SharedConfig[], id: string): SharedConfig | undefined {
  return items.find((item) => item.id === id)
}

export function sandboxDocument(html: string, channel: string): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'"
  const bridge = `<script>(function(){const channel=${JSON.stringify(channel)};const pending=new Map();let sequence=0;function send(message){parent.postMessage(Object.assign({channel:channel},message),'*')}function capture(requestId,format){const root=document.documentElement;const body=document.body;const width=Math.max(root.scrollWidth,root.clientWidth,body?body.scrollWidth:0,1);const height=Math.max(root.scrollHeight,root.clientHeight,body?body.scrollHeight:0,1);const clone=root.cloneNode(true);clone.setAttribute('xmlns','http://www.w3.org/1999/xhtml');clone.querySelectorAll('script,meta[http-equiv="Content-Security-Policy"]').forEach(function(node){node.remove()});const source=new XMLSerializer().serializeToString(clone);const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><foreignObject width="100%" height="100%">'+source+'</foreignObject></svg>';const image=new Image();image.onload=function(){try{const scale=Math.max(.1,Math.min(2,8192/Math.max(width,height)));const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);const context=canvas.getContext('2d');if(!context)throw new Error('无法创建图片画布');let background=getComputedStyle(body||root).backgroundColor;if(!background||background==='transparent'||background==='rgba(0, 0, 0, 0)')background='#fff';context.fillStyle=background;context.fillRect(0,0,canvas.width,canvas.height);context.scale(scale,scale);context.drawImage(image,0,0,width,height);send({type:'rightdata:capture-result',requestId:requestId,dataUrl:canvas.toDataURL(format==='jpeg'?'image/jpeg':'image/png',.92)})}catch(error){send({type:'rightdata:capture-result',requestId:requestId,error:String(error&&error.message||error)})}};image.onerror=function(){send({type:'rightdata:capture-result',requestId:requestId,error:'通报图片生成失败'})};image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}window.rightData=Object.freeze({query:function(definitionId,params){return new Promise(function(resolve,reject){const requestId=String(++sequence);pending.set(requestId,{resolve:resolve,reject:reject});send({type:'rightdata:query',requestId:requestId,definitionId:String(definitionId||''),params:params||{}})})}});addEventListener('message',function(event){const message=event.data||{};if(message.channel!==channel)return;if(message.type==='rightdata:result'){const task=pending.get(String(message.requestId||''));if(!task)return;pending.delete(String(message.requestId||''));message.error?task.reject(new Error(String(message.error))):task.resolve(message.data)}if(message.type==='rightdata:params'){window.rightDataParams=message.params||{};window.dispatchEvent(new CustomEvent('rightdata:params',{detail:window.rightDataParams}))}if(message.type==='rightdata:capture')capture(String(message.requestId||''),message.format==='jpeg'?'jpeg':'png')});addEventListener('DOMContentLoaded',function(){send({type:'rightdata:ready'});window.dispatchEvent(new CustomEvent('rightdata:init'))})})();</script>`
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">${bridge}`
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${head}`)
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}

