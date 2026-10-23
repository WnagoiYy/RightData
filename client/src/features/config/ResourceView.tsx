import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Skeleton } from 'antd'
import { formatError, isAccessRevoked, resourceExecutePath, resourcePath } from './core'
import { ResourceRenderer } from './ResourceRenderer'
import type { QueryResult, ResourceViewProps, SharedConfig } from './types'

type ResourceFrame = { resourceId: string; params: Record<string, unknown> }
const MAX_DRILL_DEPTH = 8

export function ResourceView({ api, resourceId, permissions, params: controlledParams, onParamsChange, onBack, className }: ResourceViewProps) {
  const [stack, setStack] = useState<ResourceFrame[]>(() => [{ resourceId, params: controlledParams ?? {} }])
  const [resource, setResource] = useState<SharedConfig>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const loadSequence = useRef(0)
  const current = stack[stack.length - 1]
  const currentResourceId = current?.resourceId ?? resourceId
  const activeResourceId = useRef(currentResourceId)
  activeResourceId.current = currentResourceId
  const rootControlled = stack.length === 1 && controlledParams !== undefined
  const params = rootControlled ? controlledParams : (current?.params ?? {})

  useEffect(() => {
    setStack([{ resourceId, params: controlledParams ?? {} }])
  }, [resourceId])

  const changeParams = (next: Record<string, unknown>) => {
    setStack((items) => items.map((item, index) => index === items.length - 1 ? { ...item, params: next } : item))
    if (stack.length === 1) onParamsChange?.(next)
  }

  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current
    setResource(undefined); setLoading(true); setError('')
    try {
      const next = await api.request<SharedConfig>(resourcePath(currentResourceId), { signal })
      if (sequence === loadSequence.current) setResource(next)
    } catch (cause) {
      if (sequence === loadSequence.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(formatError(cause, '资源加载失败'))
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [api, currentResourceId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const execute = useCallback(async (definitionId: string, values: Record<string, unknown>) => {
    const requestResourceId = currentResourceId
    try {
      return await api.request<QueryResult>(resourceExecutePath(requestResourceId), { method: 'POST', body: { definitionId, params: values } })
    } catch (cause) {
      if (activeResourceId.current === requestResourceId && isAccessRevoked(cause)) { setResource(undefined); setError(formatError(cause, '当前会话或资源权限已失效')) }
      throw cause
    }
  }, [api, currentResourceId])

  const drill = (targetResourceId: string, targetParams: Record<string, unknown>) => {
    if (!targetResourceId) return
    setStack((items) => [...items.slice(Math.max(0, items.length - MAX_DRILL_DEPTH + 1)), { resourceId: targetResourceId, params: targetParams }])
  }
  const back = () => {
    if (stack.length > 1) setStack((items) => items.slice(0, -1))
    else onBack?.()
  }
  const showBack = stack.length > 1 || !!onBack

  if (loading) return <div className={`rd-resource-view rd-config-loading${className ? ` ${className}` : ''}`}><Skeleton active /></div>
  if (error || !resource) return <div className={`rd-resource-view rd-resource-error${className ? ` ${className}` : ''}`}>{showBack ? <Button onClick={back}>返回</Button> : null}<Alert type="error" showIcon message={error || '资源不存在'} action={<Button size="small" onClick={() => void load()}>重试</Button>} /></div>
  return <section className={`rd-resource-view${className ? ` ${className}` : ''}`}>
    {showBack ? <div className="rd-resource-back"><Button type="text" onClick={back}>返回</Button><span>{resource.name}</span></div> : null}
    <ResourceRenderer key={resource.id} resource={resource} params={params} onParamsChange={changeParams} execute={execute} api={api} permissions={permissions} preview={false} onDrill={drill} />
  </section>
}

export default ResourceView
