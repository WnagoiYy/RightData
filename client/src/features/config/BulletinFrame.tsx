import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { createId, formatError, policyOf, sandboxDocument } from './core'
import { screenDocument } from './screen-document'
import type { Execute, ImageFormat } from './resource-ui'
import type { BulletinBody } from './types'
export type BulletinFrameHandle = { capture: (format: ImageFormat) => Promise<string> }

export const BulletinFrame = forwardRef<BulletinFrameHandle, { body: BulletinBody; params: Record<string, unknown>; execute: Execute; className?: string; baseUrl?: string; title?: string }>(function BulletinFrame({ body, params, execute, className, baseUrl, title }, ref) {
  const frame = useRef<HTMLIFrameElement>(null)
  const channel = useMemo(() => createId('bulletin-channel'), [body.html, baseUrl])
  const captures = useRef(new Map<string, { resolve: (dataUrl: string) => void; reject: (cause: Error) => void; timer: number }>())
  const policy = policyOf(body)
  const document = useMemo(() => baseUrl ? screenDocument(body.html ?? '', channel, baseUrl) : sandboxDocument(body.html ?? '', channel), [body.html, channel, baseUrl])
  useImperativeHandle(ref, () => ({
    capture(format) {
      return new Promise<string>((resolve, reject) => {
        const target = frame.current?.contentWindow
        if (!target) { reject(new Error('通报内容尚未就绪')); return }
        const requestId = createId('capture')
        const timer = window.setTimeout(() => {
          captures.current.delete(requestId)
          reject(new Error('通报图片生成超时'))
        }, 15_000)
        captures.current.set(requestId, { resolve, reject, timer })
        target.postMessage({ type: 'rightdata:capture', channel, requestId, format }, '*')
      })
    },
  }), [channel])
  useEffect(() => {
    const listener = (event: MessageEvent<Record<string, unknown>>) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== channel) return
      if (event.data.type === 'rightdata:ready') {
        frame.current?.contentWindow?.postMessage({ type: 'rightdata:params', channel, params }, '*')
        return
      }
      if (event.data.type === 'rightdata:capture-result') {
        const requestId = String(event.data.requestId ?? '')
        const task = captures.current.get(requestId)
        if (!task) return
        captures.current.delete(requestId); window.clearTimeout(task.timer)
        if (event.data.error) task.reject(new Error(String(event.data.error)))
        else if (typeof event.data.dataUrl === 'string') task.resolve(event.data.dataUrl)
        else task.reject(new Error('通报图片数据无效'))
        return
      }
      if (event.data.type !== 'rightdata:query') return
      const requestId = String(event.data.requestId ?? '')
      const definitionId = String(event.data.definitionId ?? '')
      const requestParams = event.data.params && typeof event.data.params === 'object' && !Array.isArray(event.data.params) ? event.data.params as Record<string, unknown> : {}
      const respond = (payload: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ ...payload, type: 'rightdata:result', channel, requestId }, '*')
      if (!policy.definitionIds.includes(definitionId)) { respond({ error: '查询定义未绑定到此通报' }); return }
      void execute(definitionId, requestParams).then((data) => respond({ data })).catch((cause) => respond({ error: formatError(cause, '查询失败') }))
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [channel, execute, params, policy.definitionIds])
  useEffect(() => () => {
    for (const task of captures.current.values()) { window.clearTimeout(task.timer); task.reject(new Error('通报内容已关闭')) }
    captures.current.clear()
  }, [channel])
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'rightdata:params', channel, params }, '*') }, [channel, params])
  return <iframe ref={frame} className={className ?? 'rd-config-bulletin-frame'} title={title ?? '通报内容'} sandbox="allow-scripts" srcDoc={document} />
})

