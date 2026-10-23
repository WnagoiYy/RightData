export type RequestOptions = {
  method?: string
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
}

export type DataApi = {
  request<T>(path: string, options?: RequestOptions): Promise<T>
  upload<T>(path: string, file: File, options?: { fields?: Record<string, string>; method?: string }): Promise<T>
  download(path: string, name: string): Promise<void>
  readDownload(path: string, maxBytes?: number): Promise<Uint8Array>
  saveFile(name: string, bytes: Uint8Array): Promise<void>
  recordExportEvent?(jobId: string, outcome: 'success' | 'failed' | 'canceled'): Promise<void>
}

export type DataFeatureProps = {
  api: DataApi
  permissions?: string[]
  taskScope?: string
}

export type DatasetSummary = {
  id: string
  name: string
}

export type DataField = {
  name: string
  dataType: string
  nullable: boolean
  default?: unknown
  primaryKey?: boolean
  unique?: boolean
  ordinal: number
}

export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'not_in'
  | 'between'
  | 'is_null'
  | 'is_not_null'
  | 'contains'
  | 'starts_with'
  | 'ends_with'

export type DataFilter = {
  logic?: 'and' | 'or'
  rules?: DataFilter[]
  field?: string
  op?: FilterOperator
  value?: unknown
  values?: unknown[]
}

export type DataOrder = {
  field: string
  direction?: 'ASC' | 'DESC'
}

export type QueryResult = {
  fields: DataField[]
  rows: Array<Record<string, unknown>>
  total: number
}

export type MutationResult = {
  inserted: number
  updated: number
  deleted: number
}

export type FieldDefinition = {
  name: string
  dataType: string
  nullable: boolean
  default?: unknown
  primaryKey?: boolean
  unique?: boolean
}

export type UploadReceipt = {
  uploadId: string
  fileName: string
  sizeBytes: number
  sha256: string
  expiresAt: string
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired'

export type DataJob = {
  id: string
  kind: 'import' | 'export' | 'backup' | string
  datasetId: string
  state: JobState
  progress: unknown
  result?: unknown
  error?: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export type DataFile = {
  id: string
  name: string
  kind: 'business' | 'backup' | string
  sourceId?: string
  ownerId: string
  size: number
  hasPassword: boolean
  createdAt: string
  connections: Array<{
    id: string
    name: string
    fileId?: string
  }>
}

export type ParsedDataFile = {
  name: string
  sheetName: string
  headers: string[]
  rows: unknown[][]
  inferredTypes: string[]
}

export type ImportMapping = {
  source: string
  target: string
  dataType: string
  included: boolean
}

