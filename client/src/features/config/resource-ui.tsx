import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Empty, Input, InputNumber, message, Select, Space, Table } from 'antd'
import { FullscreenExitOutlined, FullscreenOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { toJpeg, toPng } from 'html-to-image'
import { saveLocalFile } from '../../lib/api'
import { formatError } from './core'
import type { ConfigApi, QueryResult, ReportColumn, ResourceParameter, SharedConfig } from './types'

export type Execute = (definitionId: string, params: Record<string, unknown>) => Promise<QueryResult>
export type ImageFormat = 'png' | 'jpeg'
export type RendererProps = {
  resource: SharedConfig
  params: Record<string, unknown>
  onParamsChange: (params: Record<string, unknown>) => void
  execute: Execute
  loading?: boolean
  api?: ConfigApi
  permissions?: string[]
  preview?: boolean
  onDrill?: (resourceId: string, params: Record<string, unknown>) => void
}

function exportFileName(name: string, format: ImageFormat): string {
  const safeName = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'rightdata'
  return `${safeName}.${format === 'jpeg' ? 'jpg' : 'png'}`
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error('图片数据无效')
  const metadata = dataUrl.slice(0, separator)
  const payload = dataUrl.slice(separator + 1)
  if (!metadata.includes(';base64')) return new TextEncoder().encode(decodeURIComponent(payload))
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function ImageExportButtons({ name, capture }: { name: string; capture: (format: ImageFormat) => Promise<string> }) {
  const [exporting, setExporting] = useState<ImageFormat>()
  const save = async (format: ImageFormat) => {
    setExporting(format)
    try {
      const dataUrl = await capture(format)
      await saveLocalFile(exportFileName(name, format), dataUrlBytes(dataUrl))
      message.success('图片已保存')
    } catch (cause) {
      message.error(formatError(cause, '图片导出失败'))
    } finally {
      setExporting(undefined)
    }
  }
  return <>
    <Button size="small" loading={exporting === 'png'} disabled={!!exporting && exporting !== 'png'} onClick={() => void save('png')}>导出 PNG</Button>
    <Button size="small" loading={exporting === 'jpeg'} disabled={!!exporting && exporting !== 'jpeg'} onClick={() => void save('jpeg')}>导出 JPEG</Button>
  </>
}

export function ResourceFullscreen({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])
  useEffect(() => {
    if (!fullscreen) return
    const leaveOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => undefined)
    }
    window.addEventListener('keydown', leaveOnEscape)
    return () => window.removeEventListener('keydown', leaveOnEscape)
  }, [fullscreen])
  const toggle = async () => {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen()
      else {
        if (!root.current?.requestFullscreen) throw new Error('当前环境不支持全屏')
        await root.current.requestFullscreen()
      }
    } catch (cause) {
      message.error(formatError(cause, '全屏切换失败'))
    }
  }
  return <div ref={root} className="rd-resource-fullscreen">
    <div className="rd-resource-fullscreen-actions">
      <Button size="small" icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => void toggle()}>{fullscreen ? '退出全屏' : '进入全屏'}</Button>
    </div>
    {children}
  </div>
}

export async function captureElement(element: HTMLElement | null, format: ImageFormat, backgroundColor: string): Promise<string> {
  if (!element) throw new Error('图片内容尚未就绪')
  const options = { cacheBust: true, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), backgroundColor }
  return format === 'jpeg' ? toJpeg(element, { ...options, quality: 0.92 }) : toPng(element, options)
}

export function parameterDefaults(parameters: ResourceParameter[]): Record<string, unknown> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.key, parameter.defaultValue ?? (parameter.type === 'multiSelect' ? [] : '')]))
}

export function ResourceParameterBar({
  parameters,
  value,
  onChange,
  onSubmit,
  loading,
}: {
  parameters: ResourceParameter[]
  value: Record<string, unknown>
  onChange: (value: Record<string, unknown>) => void
  onSubmit: () => void
  loading?: boolean
}) {
  if (!parameters.length) {
    return <div className="rd-config-querybar rd-config-querybar-actions"><Button type="primary" loading={loading} onClick={onSubmit}>刷新数据</Button></div>
  }
  return (
    <div className="rd-config-querybar">
      <div className="rd-config-params">
        {parameters.map((parameter) => {
          const current = value[parameter.key]
          const set = (next: unknown) => onChange({ ...value, [parameter.key]: next })
          let control
          if (parameter.type === 'number') {
            control = <InputNumber value={typeof current === 'number' ? current : undefined} onChange={set} placeholder="请输入" />
          } else if (parameter.type === 'date') {
            control = <Input type="date" value={typeof current === 'string' ? current : ''} onChange={(event) => set(event.target.value)} />
          } else if (parameter.type === 'select' || parameter.type === 'multiSelect') {
            control = <Select allowClear mode={parameter.type === 'multiSelect' ? 'multiple' : undefined} value={current as string | string[] | undefined} options={(parameter.options ?? []).map((option) => ({ label: option, value: option }))} onChange={set} placeholder="请选择" />
          } else {
            control = <Input allowClear value={String(current ?? '')} onChange={(event) => set(event.target.value)} placeholder="请输入" />
          }
          return <label className="rd-config-param" key={parameter.key}><span>{parameter.label || parameter.key}{parameter.required ? <em>*</em> : null}</span>{control}</label>
        })}
      </div>
      <Space size={8} className="rd-config-query-actions">
        <Button onClick={() => onChange(parameterDefaults(parameters))}>重置</Button>
        <Button type="primary" loading={loading} onClick={onSubmit}>查询</Button>
      </Space>
    </div>
  )
}

export function formatCell(value: unknown, column?: ReportColumn): string {
  if (value === null || value === undefined || value === '') return '--'
  if (column?.format === 'number' && typeof value === 'number') return value.toLocaleString('zh-CN')
  if (column?.format === 'percent' && typeof value === 'number') return `${(value * 100).toFixed(2).replace(/\.00$/, '')}%`
  if ((column?.format === 'date' || column?.format === 'datetime') && typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return column.format === 'date' ? date.toLocaleDateString('zh-CN') : date.toLocaleString('zh-CN')
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const cellCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function compareCellValues(left: unknown, right: unknown): number {
  if (left === right) return 0
  if (left === null || left === undefined) return 1
  if (right === null || right === undefined) return -1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  const leftText = typeof left === 'object' ? JSON.stringify(left) : String(left)
  const rightText = typeof right === 'object' ? JSON.stringify(right) : String(right)
  return cellCollator.compare(leftText, rightText)
}

export function ResultTable({ result, configuredColumns, pageSize = 20 }: { result?: QueryResult; configuredColumns?: ReportColumn[]; pageSize?: number }) {
  const columns = useMemo<ColumnsType<Record<string, unknown>>>(() => {
    if (!result) return []
    const preferred = (configuredColumns ?? []).filter((column) => column.key)
    const source: ReportColumn[] = preferred.length ? preferred : result.fields.map((field) => ({ key: field.name, title: field.name }))
    return source.map((column) => ({
      title: column.title || column.key,
      dataIndex: column.key,
      key: column.key,
      width: column.width,
      ellipsis: true,
      sorter: (left, right) => compareCellValues(left[column.key], right[column.key]),
      render: (value: unknown) => formatCell(value, column),
    }))
  }, [configuredColumns, result])
  if (!result) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="执行查询后显示数据" />
  return <Table
    size="small"
    rowKey={(_, index) => String(index)}
    columns={columns}
    dataSource={result.rows}
    pagination={{ pageSize: Math.max(1, pageSize), showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
    scroll={{ x: 'max-content' }}
    summary={(currentRows) => columns.length ? <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={columns.length}>当前页 {currentRows.length} 条 · 已加载 {result.rows.length} 条 · 查询总数 {result.total} 条</Table.Summary.Cell></Table.Summary.Row> : null}
  />
}

