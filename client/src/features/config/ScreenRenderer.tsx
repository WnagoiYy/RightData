import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Skeleton, Space, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { native } from '../../lib/api'
import { BulletinFrame } from './BulletinFrame'
import { formatError, isAccessRevoked, resourcePath } from './core'
import { parameterDefaults, ResourceParameterBar, type RendererProps } from './resource-ui'
import type { ScreenBody, SharedConfig } from './types'

type PreparedScreen = { resourceId: string; version: string; entryHtml: string; baseUrl: string; cacheHit: boolean; sha256: string }
const release = (screen?: PreparedScreen) => { if (screen) void native('screen_release', { request: { baseUrl: screen.baseUrl } }).catch(() => {}) }
const unavailable = (cause: unknown) => isAccessRevoked(cause) || (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 404)

export function ScreenRenderer({ resource, body, params, onParamsChange, execute, api, preview }: RendererProps & { body: ScreenBody }) {
  const [prepared, setPrepared] = useState<PreparedScreen>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [availableVersion, setAvailableVersion] = useState('')
  const current = useRef<PreparedScreen | undefined>(undefined)
  const requestSequence = useRef(0)
  const version = preview ? resource.previewVersion : undefined
  const resourceId = resource.id
  const visibleScreen = prepared?.resourceId === resourceId && (!preview || prepared.version === version) ? prepared : undefined

  const clear = useCallback(() => {
    release(current.current)
    current.current = undefined
    setPrepared(undefined)
  }, [])

  const prepare = useCallback(async () => {
    if (preview && !version) return
    const sequence = ++requestSequence.current
    setLoading(true); setError('')
    try {
      const result = await native<PreparedScreen>('screen_prepare', { request: { resourceId, version, preview: preview === true } })
      if (sequence !== requestSequence.current) { release(result); return }
      const old = current.current
      current.current = result
      setPrepared(result); setAvailableVersion('')
      release(old)
    } catch (cause) {
      if (sequence !== requestSequence.current) return
      if (unavailable(cause)) clear()
      setError(formatError(cause, '大屏加载失败'))
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [clear, preview, resourceId, version])

  useEffect(() => {
    clear(); setAvailableVersion(''); setError('')
    void prepare()
    return () => { requestSequence.current += 1; release(current.current); current.current = undefined }
  }, [clear, prepare])

  useEffect(() => {
    const parameters = body.parameters ?? []
    if (parameters.length && Object.keys(params).length === 0) onParamsChange(parameterDefaults(parameters))
  }, [body.parameters, onParamsChange, params])

  useEffect(() => {
    if (preview || !api) return
    const controller = new AbortController()
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const latest = await api.request<SharedConfig>(resourcePath(resourceId), { signal: controller.signal })
        if (!controller.signal.aborted) {
          if (!latest.publishedVersion?.version) {
            requestSequence.current += 1; clear(); setLoading(false); setAvailableVersion(''); setError('大屏尚未发布')
          } else if (current.current) setAvailableVersion(latest.publishedVersion.version === current.current.version ? '' : latest.publishedVersion.version)
        }
      } catch (cause) {
        if (!controller.signal.aborted && unavailable(cause)) { requestSequence.current += 1; clear(); setLoading(false); setError(formatError(cause, '大屏访问权限已失效')) }
      } finally { checking = false }
    }
    const timer = window.setInterval(() => void check(), 60_000)
    window.addEventListener('focus', check)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', check) }
  }, [api, clear, preview, resourceId])

  return <div className="rd-screen-runtime">
    {(body.parameters ?? []).length ? <ResourceParameterBar parameters={body.parameters ?? []} value={params} onChange={onParamsChange} onSubmit={() => void prepare()} loading={loading} /> : null}
    <div className="rd-screen-runtime-toolbar"><Space size={6}>
      {visibleScreen ? <Tag>{visibleScreen.version}</Tag> : null}
      {availableVersion ? <Button size="small" type="primary" loading={loading} onClick={() => void prepare()}>加载 {availableVersion}</Button> : null}
    </Space><Button size="small" icon={<ReloadOutlined />} loading={loading} disabled={preview && !version} onClick={() => void prepare()}>刷新</Button></div>
    {error ? <Alert type="error" showIcon message={error} /> : null}
    {visibleScreen ? <BulletinFrame key={visibleScreen.baseUrl} title="数据大屏" className="rd-screen-frame" body={{ ...body, html: visibleScreen.entryHtml }} baseUrl={visibleScreen.baseUrl} params={params} execute={execute} /> : loading ? <Skeleton active /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={preview && !version ? '选择资源版本进行预览' : '大屏尚未加载'} />}
  </div>
}
