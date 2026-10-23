import { useEffect, useRef } from 'react'
import { Empty, Skeleton } from 'antd'
import { BulletinFrame, type BulletinFrameHandle } from './BulletinFrame'
import { ReportRenderer } from './ReportRenderer'
import { DashboardRenderer } from './DashboardRenderer'
import { ScreenRenderer } from './ScreenRenderer'
import { ImageExportButtons, ResourceFullscreen, parameterDefaults, ResourceParameterBar, type RendererProps } from './resource-ui'
import type { BulletinBody, DashboardBody, ReportBody, ScreenBody } from './types'
import './config.css'
export { ResourceParameterBar, ResultTable } from './resource-ui'

function BulletinRenderer({ resource, body, params, onParamsChange, execute }: RendererProps & { body: BulletinBody }) {
  const frame = useRef<BulletinFrameHandle>(null)
  useEffect(() => {
    const parameters = body.parameters ?? []
    if (parameters.length && Object.keys(params).length === 0) onParamsChange(parameterDefaults(parameters))
  }, [body.parameters, onParamsChange, params])
  return <div className="rd-config-runtime">
    {(body.parameters ?? []).length ? <ResourceParameterBar parameters={body.parameters ?? []} value={params} onChange={onParamsChange} onSubmit={() => undefined} /> : null}
    <div className="rd-config-export-actions"><ImageExportButtons name={resource.name} capture={(format) => frame.current?.capture(format) ?? Promise.reject(new Error('通报内容尚未就绪'))} /></div>
    <BulletinFrame ref={frame} body={body} params={params} execute={execute} />
  </div>
}

export function ResourceRenderer(props: RendererProps) {
  if (props.loading) return <div className="rd-config-loading"><Skeleton active /></div>
  if (props.resource.kind === 'report') return <ResourceFullscreen><ReportRenderer {...props} body={props.resource.body as ReportBody} /></ResourceFullscreen>
  if (props.resource.kind === 'dashboard') return <ResourceFullscreen><DashboardRenderer {...props} body={props.resource.body as DashboardBody} /></ResourceFullscreen>
  if (props.resource.kind === 'screen') return <ResourceFullscreen><ScreenRenderer {...props} body={props.resource.body as ScreenBody} /></ResourceFullscreen>
  if (props.resource.kind === 'h5') return <ResourceFullscreen><BulletinRenderer {...props} body={props.resource.body as BulletinBody} /></ResourceFullscreen>
  return <Empty description="不支持的资源类型" />
}

