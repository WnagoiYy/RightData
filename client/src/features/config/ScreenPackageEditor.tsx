import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, message, Popconfirm, Space, Table, Tag, Upload } from 'antd'
import { ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { dateTime, fileSize } from '../../components/Feedback'
import { formatError, idempotencyKey, isConflict } from './core'
import type { ConfigApi, ScreenVersion, SharedConfig } from './types'

type VersionList = { items: ScreenVersion[]; publishedVersion: ScreenVersion | null; publishRevision: number; publishedAt: string | null }
type PublishResult = Omit<VersionList, 'items'>

export function ScreenPackageEditor({ api, resource, selectedVersion, configDirty, onSelect, onPublished }: {
  api: ConfigApi
  resource: SharedConfig
  selectedVersion?: string
  configDirty: boolean
  onSelect(version: string): void
  onPublished(): void
}) {
  const [versions, setVersions] = useState<VersionList>({ items: [], publishedVersion: null, publishRevision: 0, publishedAt: null })
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [publishing, setPublishing] = useState<string>()
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const requestSequence = useRef(0)
  const scope = useRef(0)
  const resourceRef = useRef(resource.id); resourceRef.current = resource.id
  const selectedRef = useRef(selectedVersion); selectedRef.current = selectedVersion
  const selectRef = useRef(onSelect); selectRef.current = onSelect
  const publishIntent = useRef<{ fingerprint: string; key: string } | undefined>(undefined)
  const path = `/api/v1/screens/${encodeURIComponent(resource.id)}`
  const saved = resource.version > 0

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!saved) return
    const sequence = ++requestSequence.current
    setLoading(true); setError('')
    try {
      const result = await api.request<VersionList>(`${path}/versions?limit=20&offset=0`, { signal })
      if (sequence !== requestSequence.current || resourceRef.current !== resource.id || signal?.aborted) return
      setVersions(result)
      setHasMore(result.items.length === 20)
      if (!result.items.some(item => item.version === selectedRef.current)) {
        const selected = result.publishedVersion?.version ?? result.items[0]?.version
        if (selected) selectRef.current(selected)
      }
    } catch (cause) {
      if (sequence === requestSequence.current && resourceRef.current === resource.id && !signal?.aborted) setError(formatError(cause, '大屏版本加载失败'))
    } finally {
      if (sequence === requestSequence.current && resourceRef.current === resource.id) setLoading(false)
    }
  }, [api, path, resource.id, saved])

  const loadMore = async () => {
    const sequence = ++requestSequence.current
    setLoading(true); setError('')
    try {
      const result = await api.request<VersionList>(`${path}/versions?limit=20&offset=${versions.items.length}`)
      if (sequence !== requestSequence.current || resourceRef.current !== resource.id) return
      setVersions(current => ({ ...current, items: [...current.items, ...result.items.filter(item => !current.items.some(existing => existing.version === item.version))] }))
      setHasMore(result.items.length === 20)
    } catch (cause) {
      if (sequence === requestSequence.current && resourceRef.current === resource.id) setError(formatError(cause, '大屏版本加载失败'))
    } finally {
      if (sequence === requestSequence.current && resourceRef.current === resource.id) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    scope.current += 1
    setVersions({ items: [], publishedVersion: null, publishRevision: 0, publishedAt: null })
    setUploading(false); setPublishing(undefined); setLoading(false); setError(''); setHasMore(false)
    publishIntent.current = undefined
    void load(controller.signal)
    return () => { controller.abort(); requestSequence.current += 1; scope.current += 1 }
  }, [load])

  const upload = async (file: File) => {
    if (!saved || uploading || publishing) return
    if (!/\.zip$/i.test(file.name)) { message.warning('请选择 ZIP 资源包'); return }
    if (file.size > 50 * 1024 * 1024) { message.warning('资源包不能超过 50 MiB'); return }
    const resourceId = resource.id
    const operationScope = scope.current
    const active = () => scope.current === operationScope && resourceRef.current === resourceId
    setUploading(true); setError('')
    try {
      const version = await api.upload<ScreenVersion>(`${path}/versions`, file)
      if (!active()) return
      onSelect(version.version)
      message.success('版本已上传')
      await load()
    } catch (cause) {
      if (active()) setError(formatError(cause, '资源包上传失败'))
    } finally {
      if (active()) setUploading(false)
    }
  }

  const publish = async (version: string) => {
    if (publishing || uploading || configDirty) return
    const resourceId = resource.id
    const operationScope = scope.current
    const active = () => scope.current === operationScope && resourceRef.current === resourceId
    const body = { version, expectedRevision: versions.publishRevision }
    const fingerprint = JSON.stringify({ resourceId, ...body })
    if (publishIntent.current?.fingerprint !== fingerprint) publishIntent.current = { fingerprint, key: idempotencyKey('publish-screen', resourceId) }
    requestSequence.current += 1
    setLoading(false); setPublishing(version); setError('')
    try {
      const result = await api.request<PublishResult>(`${path}/publish`, { method: 'POST', body, idempotencyKey: publishIntent.current.key })
      if (!active()) return
      publishIntent.current = undefined
      setVersions(current => ({ ...current, ...result }))
      onSelect(version); onPublished()
      message.success(`已发布 ${version}`)
    } catch (cause) {
      if (!active()) return
      if (isConflict(cause)) {
        publishIntent.current = undefined
        await load()
        if (active()) setError('发布版本已被修改，请核对当前版本后重试')
      } else setError(formatError(cause, '发布失败'))
    } finally {
      if (active()) setPublishing(undefined)
    }
  }

  if (!saved) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="保存配置后可上传大屏资源包" />
  return <div className="rd-screen-packages">
    <div className="rd-config-section-head"><Space size={6}><strong>资源版本</strong>{versions.publishedVersion ? <Tag color="success">已发布 {versions.publishedVersion.version}</Tag> : <Tag>未发布</Tag>}</Space><Space size={4}>
      <Button size="small" aria-label="刷新大屏版本" icon={<ReloadOutlined />} loading={loading} disabled={!!publishing} onClick={() => void load()} />
      <Upload accept=".zip,application/zip" showUploadList={false} disabled={!!publishing} beforeUpload={file => { void upload(file); return false }}><Button size="small" icon={<UploadOutlined />} loading={uploading} disabled={!!publishing}>上传 ZIP</Button></Upload>
    </Space></div>
    {error ? <Alert type="error" showIcon message={error} /> : null}
    {configDirty ? <Alert type="warning" message="保存配置更改后可发布资源版本" /> : null}
    <Table<ScreenVersion> size="small" rowKey="version" loading={loading} dataSource={versions.items} pagination={false} scroll={{ x: 470, y: 280 }} locale={{ emptyText: '暂无资源版本' }} columns={[
      { title: '版本', dataIndex: 'version', width: 110, render: version => <Space size={4}>{version}{selectedVersion === version ? <Tag>预览</Tag> : null}</Space> },
      { title: '大小', dataIndex: 'sizeBytes', width: 86, render: fileSize },
      { title: '上传时间', dataIndex: 'createdAt', width: 165, render: dateTime },
      { title: '操作', width: 125, render: (_, version) => <Space size={0}>
        <Button size="small" type="link" onClick={() => onSelect(version.version)}>预览</Button>
        <Popconfirm title={`发布 ${version.version}？`} description={versions.publishedVersion ? `当前版本为 ${versions.publishedVersion.version}` : undefined} okText="发布" cancelText="取消" onConfirm={() => void publish(version.version)}>
          <Button size="small" type="link" loading={publishing === version.version} disabled={configDirty || !!publishing || uploading || versions.publishedVersion?.version === version.version}>发布</Button>
        </Popconfirm>
      </Space> },
    ]} />
    {hasMore ? <Button size="small" loading={loading} disabled={!!publishing} onClick={() => void loadMore()}>加载更多版本</Button> : null}
  </div>
}
