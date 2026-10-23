import type { ReactNode } from 'react'

export type ConfigApi = {
  request<T>(path: string, options?: {
    method?: string
    body?: unknown
    idempotencyKey?: string
    signal?: AbortSignal
  }): Promise<T>
  upload<T>(path: string, file: File): Promise<T>
  download(path: string, name: string): Promise<void>
}

export type ServerConfigKind = 'report' | 'dashboard' | 'screen' | 'menu' | 'h5' | 'query' | 'role'
export type WorkspaceKind = 'report' | 'dashboard' | 'screen' | 'menu' | 'bulletin' | 'query' | 'role' | 'all'
export type ResourceKind = 'report' | 'dashboard' | 'screen' | 'h5'

export type ScreenFile = {
  path: string
  size: number
  sha256: string
}

export type ScreenVersion = {
  screenId: string
  version: string
  entry: string
  containerApiVersion: number
  files: ScreenFile[]
  sha256: string
  sizeBytes: number
  createdAt: string
  downloadUrl: string
}

export type SharedConfig<TBody = Record<string, unknown>> = {
  id: string
  kind: ServerConfigKind
  name: string
  body: TBody
  ownerId: string
  version: number
  updatedAt: string
  publishedVersion?: ScreenVersion | null
  publishRevision?: number
  publishedAt?: string | null
  previewVersion?: string
}

export type ConfigListResponse = { items: SharedConfig[] }

export type ResourcePolicy = {
  enabled: boolean
  permissions: string[]
  definitionIds: string[]
}

export type ParameterType = 'text' | 'number' | 'date' | 'select' | 'multiSelect'
export type ResourceParameter = {
  key: string
  label: string
  type: ParameterType
  required?: boolean
  defaultValue?: unknown
  options?: string[]
}

export type ReportColumn = {
  key: string
  title: string
  visible?: boolean
  width?: number
  align?: 'left' | 'center' | 'right'
  format?: 'text' | 'number' | 'percent' | 'date' | 'datetime'
  decimals?: number
  unit?: string
  summary?: 'sum' | 'avg' | 'min' | 'max' | 'count'
}

export type ReportSort = {
  key: string
  direction: 'ascend' | 'descend'
}

export type ReportParameterBinding = {
  parameterKey: string
  queryParameterKey: string
}

export type ReportDrilldown = {
  triggerField: string
  targetResourceId: string
  parameterMappings: Array<{
    sourceField: string
    targetParameter: string
  }>
}

export type ReportMaintenance = {
  definitionId: string
  datasetId: string
  table: string
  keyFields: string[]
  writableFields: string[]
  allowInsert?: boolean
  allowUpdate?: boolean
  allowDelete?: boolean
}

export type ReportBody = ResourcePolicy & {
  description?: string
  primaryDefinitionId?: string
  parameters?: ResourceParameter[]
  parameterBindings?: ReportParameterBinding[]
  columns?: ReportColumn[]
  defaultSorts?: ReportSort[]
  drilldowns?: ReportDrilldown[]
  maintenance?: ReportMaintenance
  pageSize?: number
}

export type DashboardWidgetType = 'metric' | 'table' | 'bar' | 'line' | 'pie' | 'gauge' | 'progress' | 'text'
export type DashboardValueFormat = 'number' | 'integer' | 'percent' | 'compact'
export type DashboardAggregation = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max'
export type DashboardSortDirection = 'asc' | 'desc'
export type DashboardViewport = 'desktop' | 'tablet' | 'mobile'
export type DashboardWidgetLayout = {
  x: number
  y: number
  width: number
  height: number
}
export type DashboardParameterBinding = {
  dashboardKey: string
  queryKey: string
}
export type DashboardWidget = {
  id: string
  title: string
  type: DashboardWidgetType
  definitionId?: string
  valueField?: string
  categoryField?: string
  gridSpan?: 1 | 2
  valueFormat?: DashboardValueFormat
  decimalPlaces?: number
  aggregation?: DashboardAggregation
  sortField?: string
  sortDirection?: DashboardSortDirection
  limit?: number
  color?: string
  fontSize?: number
  showLegend?: boolean
  maxValue?: number
  parameterBindings?: DashboardParameterBinding[]
  layouts?: Partial<Record<DashboardViewport, DashboardWidgetLayout>>
  text?: string
}

export type DashboardBody = ResourcePolicy & {
  description?: string
  theme?: 'light' | 'dark'
  refreshSeconds?: number
  parameters?: ResourceParameter[]
  widgets?: DashboardWidget[]
}

export type ScreenBody = ResourcePolicy & {
  parameters?: ResourceParameter[]
}

export type BulletinBody = ResourcePolicy & {
  description?: string
  html?: string
  parameters?: ResourceParameter[]
}

export type MenuBody = {
  enabled: boolean
  permissions: string[]
  parentId: string
  order: number
  resourceId: string
  resourceKind: '' | ResourceKind
}

export type QueryDefinitionBody = {
  datasetId?: string
  sql?: string
  query?: Record<string, unknown>
  permissions: string[]
}

export type RoleBody = {
  permissions: string[]
  description?: string
}

export type QueryField = { name: string; type?: string }
export type QueryResult = {
  fields: QueryField[]
  rows: Array<Record<string, unknown>>
  total: number
}

export type ResourcePreviewResponse = {
  body: Record<string, unknown>
  data?: QueryResult
}

export type ConfigWorkspaceProps = {
  api: ConfigApi
  kind?: WorkspaceKind
  onOpenResource?: (resource: SharedConfig, previewParams: Record<string, unknown>) => void
  onChanged?: (resource: SharedConfig | null) => void
  historyScope?: string
  className?: string
  emptyExtra?: ReactNode
}

export type ResourceViewProps = {
  api: ConfigApi
  resourceId: string
  permissions?: string[]
  params?: Record<string, unknown>
  onParamsChange?: (params: Record<string, unknown>) => void
  onBack?: () => void
  className?: string
}

