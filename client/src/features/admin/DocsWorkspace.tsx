import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api as defaultApi, errorMessage, native, type Api, type TransportState } from '../../lib/api';
import { Failure } from '../../components/Feedback';

const bridgeScript = `
const pending = new Map(); let sequence = 0;
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'rightdata:docs:response') return;
  const handler = pending.get(event.data.id); if (!handler) return;
  pending.delete(event.data.id); clearTimeout(handler.timer);
  const status = event.data.status;
  handler.resolve(new Response([204,205,304].includes(status) ? null : JSON.stringify(event.data.data), {status, headers:{'Content-Type':'application/json'}}));
});
window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, document.baseURI || 'https://rightdata.invalid');
  const ownOrigin = new URL(document.baseURI || 'https://rightdata.invalid').origin;
  if (![ownOrigin, window.__rightDataBackendOrigin].includes(url.origin) || !url.pathname.startsWith('/api/')) throw new Error('仅允许访问当前服务接口');
  const method = (init.method || input.method || 'GET').toUpperCase();
  let body = init.body;
  if (body === undefined && input instanceof Request && method !== 'GET' && method !== 'HEAD') body = await input.clone().text();
  if (body instanceof FormData) throw new Error('请使用文件管理或数据导入上传文件');
  if (typeof body === 'string' && body.trim()) { try { body = JSON.parse(body); } catch { throw new Error('此调试入口要求 JSON 请求体'); } }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('请求超时')); }, 60000);
    pending.set(id, {resolve,reject,timer});
    parent.postMessage({type:'rightdata:docs:request',id,path:url.pathname+url.search,method,body}, '*');
  });
};`;

export function DocsWorkspace({ api = defaultApi }: { api?: Api }) {
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const frame = useRef<HTMLIFrameElement>(null);
  const version = useRef(0);
  const load = useCallback(async () => {
    const requestVersion = ++version.current;
    setBusy(true); setError(undefined); setHtml('');
    try {
      const [page, css, script, transport] = await Promise.all([
        api.request<string>('/api/swagger'), api.request<string>('/api/swagger/assets/swagger-ui.css'), api.request<string>('/api/swagger/assets/swagger-ui-bundle.js'),
        native<TransportState>('transport_get_state'),
      ]);
      if (requestVersion !== version.current) return;
      const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
      const backendOrigin = JSON.stringify(new URL(transport.settings.serverUrl).origin).replace(/</g, '\\u003c');
      const result = page.replace('<head>', () => `<head>${policy}<script>window.__rightDataBackendOrigin=${backendOrigin};${bridgeScript}</script>`)
        .replace(/<link[^>]*href="\/api\/swagger\/assets\/swagger-ui\.css"[^>]*>/, () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
        .replace(/<script[^>]*src="\/api\/swagger\/assets\/swagger-ui-bundle\.js"[^>]*><\/script>/, () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`);
      setHtml(result);
    } catch (cause) { if (requestVersion === version.current) setError(cause); }
    finally { if (requestVersion === version.current) setBusy(false); }
  }, [api]);
  useEffect(() => { void load(); return () => { version.current++; }; }, [load]);
  useEffect(() => {
    const listener = async (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.data?.type !== 'rightdata:docs:request') return;
      const { id, path, method, body } = event.data as { id: unknown; path: unknown; method: unknown; body: unknown };
      if (typeof id !== 'number' || typeof path !== 'string' || !/^\/api\/[a-zA-Z0-9/_:?.%=&+-]+$/.test(path) || path.includes('..') || typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
      const target = frame.current.contentWindow;
      try { const response = await api.rawRequest(path, { method, body, idempotencyKey: method === 'GET' ? undefined : crypto.randomUUID() }); target?.postMessage({ type: 'rightdata:docs:response', id, status: response.status, data: response.data }, '*'); }
      catch (cause) { const status = typeof cause === 'object' && cause && 'status' in cause ? Number(cause.status) || 500 : 500; target?.postMessage({ type: 'rightdata:docs:response', id, status, data: { message: errorMessage(cause) } }, '*'); }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [api]);
  return <div className="workspace-stack docs-workspace"><div className="toolbar"><div className="toolbar-spacer" /><Button icon={<ReloadOutlined />} loading={busy} onClick={() => void load()}>刷新文档</Button></div><Failure error={error} retry={() => void load()} />{busy && <Spin />}{html && <iframe ref={frame} title="服务端接口文档" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} className="docs-frame" />}</div>;
}
