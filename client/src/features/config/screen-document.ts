import { sandboxDocument } from './core'

export function screenDocument(html: string, channel: string, baseUrl: string): string {
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' || base.hostname !== 'rd-screen.localhost' || base.port || !/^\/[A-Za-z0-9_-]+\/$/.test(base.pathname) || base.search || base.hash || base.username || base.password) {
    throw new Error('大屏本地资源地址无效')
  }
  const document = new DOMParser().parseFromString(sandboxDocument(html, channel), 'text/html')
  document.querySelectorAll('base, meta[http-equiv]').forEach(element => {
    const directive = element.getAttribute('http-equiv')?.toLowerCase()
    if (element.tagName === 'BASE' || directive === 'content-security-policy' || directive === 'refresh') element.remove()
  })
  const origin = base.origin
  const policy = document.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = `default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline' ${origin}; img-src data: blob: ${origin}; font-src data: ${origin}; media-src ${origin}; connect-src ${origin}; worker-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri ${origin}`
  const baseElement = document.createElement('base')
  baseElement.href = base.href
  document.head.prepend(baseElement)
  document.head.prepend(policy)
  return `<!doctype html>${document.documentElement.outerHTML}`
}
