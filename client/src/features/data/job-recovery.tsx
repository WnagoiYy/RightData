import { Button, Input, Select } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { encodePath, errorMessage } from './data-utils'
import type { DataApi, DataJob } from './types'

export type JobReference = {
  jobId: string
  kind: string
  createdAt: string
  label: string
}

const storagePrefix = 'rightdata:job-history:v1:'
const maximumReferences = 20

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function storageKey(taskScope: string, kind: string): string {
  return `${storagePrefix}${encodeURIComponent(taskScope)}:${encodeURIComponent(kind)}`
}

function validReference(value: unknown): value is JobReference {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<JobReference>
  return typeof item.jobId === 'string' && item.jobId.length > 0 && item.jobId.length <= 128
    && typeof item.kind === 'string' && item.kind.length > 0 && item.kind.length <= 24
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 160
}

export function readJobReferences(taskScope: string | undefined, kind: string): JobReference[] {
  if (!taskScope) return []
  try {
    const encoded = storage()?.getItem(storageKey(taskScope, kind))
    if (!encoded) return []
    const parsed = JSON.parse(encoded) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validReference).map(compactReference).slice(0, maximumReferences)
  } catch {
    return []
  }
}

function writeJobReferences(taskScope: string | undefined, kind: string, references: JobReference[]): void {
  if (!taskScope) return
  try {
    storage()?.setItem(storageKey(taskScope, kind), JSON.stringify(references.map(compactReference).slice(0, maximumReferences)))
  } catch {
    // In-memory recovery remains available when persistent storage is unavailable.
  }
}

function compactReference(reference: JobReference): JobReference {
  return {
    jobId: reference.jobId.trim().slice(0, 128),
    kind: reference.kind.trim().slice(0, 24),
    createdAt: Number.isFinite(Date.parse(reference.createdAt)) ? reference.createdAt : new Date().toISOString(),
    label: reference.label.trim().slice(0, 160) || reference.kind,
  }
}

function accessStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { status?: unknown; code?: unknown }
  if (typeof value.status === 'number') return value.status
  if (value.code === 'job_not_found') return 404
  if (value.code === 'forbidden') return 403
  return undefined
}

type RecoverableJobOptions = {
  api: DataApi
  canReadJobs: boolean
  kind: string
  taskScope?: string
  fallbackLabel: string
  onError(message: string): void
  onRecovered?(job: DataJob, reference: JobReference): void
  resolveLabel?(job: DataJob, reference?: JobReference): string | undefined
}

export function useRecoverableJob({
  api,
  canReadJobs,
  kind,
  taskScope,
  fallbackLabel,
  onError,
  onRecovered,
  resolveLabel,
}: RecoverableJobOptions) {
  const [job, setJobState] = useState<DataJob | null>(null)
  const [references, setReferences] = useState<JobReference[]>([])
  const [activeId, setActiveId] = useState('')
  const [recovering, setRecovering] = useState(false)
  const scopeRef = useRef(taskScope)
  const referencesRef = useRef(references)
  const jobRef = useRef<DataJob | null>(null)
  const activeIdRef = useRef('')
  const requestSequenceRef = useRef(0)
  const recoveredRef = useRef(onRecovered)
  const resolveLabelRef = useRef(resolveLabel)

  scopeRef.current = taskScope
  referencesRef.current = references
  recoveredRef.current = onRecovered
  resolveLabelRef.current = resolveLabel

  const setJob = useCallback((next: DataJob | null) => {
    jobRef.current = next
    setJobState(next)
  }, [])

  const replaceReferences = useCallback((next: JobReference[]) => {
    referencesRef.current = next
    setReferences(next)
    writeJobReferences(scopeRef.current, kind, next)
  }, [kind])

  const rememberReference = useCallback((reference: JobReference) => {
    const compact = compactReference(reference)
    const next = [compact, ...referencesRef.current.filter((item) => item.jobId !== compact.jobId)]
      .slice(0, maximumReferences)
    replaceReferences(next)
    return compact
  }, [replaceReferences])

  const forgetReference = useCallback((jobId: string) => {
    replaceReferences(referencesRef.current.filter((item) => item.jobId !== jobId))
  }, [replaceReferences])

  const requestJob = useCallback(async (jobId: string, label: string | undefined, mode: 'select' | 'poll') => {
    const id = jobId.trim()
    if (!id || !canReadJobs) return
    if (id.length > 128) {
      if (mode === 'select') {
        requestSequenceRef.current += 1
        activeIdRef.current = ''
        setActiveId('')
        setJob(null)
      }
      onError('任务 ID 无效')
      return
    }
    if (mode === 'poll' && activeIdRef.current !== id) return
    const requestScope = taskScope
    const requestSequence = ++requestSequenceRef.current
    const preserveCurrent = jobRef.current?.id === id
    if (mode === 'select') {
      activeIdRef.current = id
      setActiveId(id)
      if (!preserveCurrent) setJob(null)
      setRecovering(true)
    }
    try {
      const current = await api.request<DataJob>(`/api/v1/jobs/${encodePath(id)}`)
      if (scopeRef.current !== requestScope || requestSequenceRef.current !== requestSequence || activeIdRef.current !== id) return
      if (current.kind !== kind) {
        setJob(null)
        activeIdRef.current = ''
        setActiveId('')
        onError('任务类型不匹配')
        return
      }
      const existing = referencesRef.current.find((item) => item.jobId === id)
      const reference = rememberReference({
        jobId: id,
        kind,
        createdAt: existing?.createdAt || current.createdAt || new Date().toISOString(),
        label: label || resolveLabelRef.current?.(current, existing) || existing?.label || fallbackLabel,
      })
      setJob(current)
      recoveredRef.current?.(current, reference)
    } catch (error) {
      if (scopeRef.current !== requestScope || requestSequenceRef.current !== requestSequence || activeIdRef.current !== id) return
      const status = accessStatus(error)
      if (status === 404 || status === 403) {
        setJob(null)
        activeIdRef.current = ''
        setActiveId('')
        forgetReference(id)
        onError(status === 404 ? '任务不存在' : '无权读取该任务')
      } else {
        if (mode === 'select' && !preserveCurrent) {
          activeIdRef.current = ''
          setActiveId('')
        }
        onError(errorMessage(error))
      }
    } finally {
      if (scopeRef.current === requestScope && requestSequenceRef.current === requestSequence) setRecovering(false)
    }
  }, [api, canReadJobs, fallbackLabel, forgetReference, kind, onError, rememberReference, taskScope])

  const recover = useCallback((jobId: string, label?: string) => requestJob(jobId, label, 'select'), [requestJob])
  const poll = useCallback((jobId: string) => requestJob(jobId, undefined, 'poll'), [requestJob])

  useEffect(() => {
    requestSequenceRef.current += 1
    activeIdRef.current = ''
    setJob(null)
    setActiveId('')
    setRecovering(false)
    const next = readJobReferences(taskScope, kind).filter((item) => item.kind === kind)
    referencesRef.current = next
    setReferences(next)
    if (canReadJobs && next[0]) void recover(next[0].jobId, next[0].label)
    return () => {
      requestSequenceRef.current += 1
      activeIdRef.current = ''
    }
  }, [canReadJobs, kind, recover, setJob, taskScope])

  useEffect(() => {
    if (!job || ['succeeded', 'failed', 'canceled', 'expired'].includes(job.state) || !canReadJobs) return
    const jobId = job.id
    const timer = window.setTimeout(() => {
      if (activeIdRef.current === jobId) void poll(jobId)
    }, 1400)
    return () => window.clearTimeout(timer)
  }, [canReadJobs, job, poll])

  const rememberSubmitted = useCallback((submitted: DataJob, label: string) => {
    requestSequenceRef.current += 1
    activeIdRef.current = submitted.id
    const reference = rememberReference({
      jobId: submitted.id,
      kind,
      createdAt: submitted.createdAt || new Date().toISOString(),
      label,
    })
    setJob(submitted)
    setActiveId(submitted.id)
    setRecovering(false)
    recoveredRef.current?.(submitted, reference)
  }, [kind, rememberReference, setJob])

  const clearCurrent = useCallback(() => {
    requestSequenceRef.current += 1
    activeIdRef.current = ''
    setJob(null)
    setActiveId('')
    setRecovering(false)
  }, [setJob])

  return {
    job,
    setJob,
    references,
    activeId,
    activeReference: references.find((item) => item.jobId === activeId),
    recovering,
    recover,
    rememberSubmitted,
    clearCurrent,
  }
}

type JobRecoveryControlsProps = {
  kind: 'import' | 'export' | 'backup'
  kindLabel: string
  references: JobReference[]
  activeId: string
  recovering: boolean
  onRecover(jobId: string, label?: string): void
}

export function JobRecoveryControls({ kind, kindLabel, references, activeId, recovering, onRecover }: JobRecoveryControlsProps) {
  const [manualId, setManualId] = useState('')
  const submitManual = () => {
    const id = manualId.trim()
    if (!id) return
    onRecover(id)
    setManualId('')
  }
  return <div className="rd-job-recovery" data-testid={`${kind}-job-recovery`}>
    <Select
      data-testid={`${kind}-recent-jobs`}
      size="small"
      aria-label={`${kindLabel}最近任务`}
      value={activeId || undefined}
      placeholder="最近任务"
      loading={recovering}
      options={references.map((item) => ({
        value: item.jobId,
        label: `${item.label} · ${new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}`,
      }))}
      onChange={(id) => onRecover(id, references.find((item) => item.jobId === id)?.label)}
    />
    <Input.Search
      data-testid={`${kind}-job-id`}
      size="small"
      aria-label={`${kindLabel}任务 ID`}
      value={manualId}
      placeholder="任务 ID"
      enterButton={<span data-testid={`${kind}-job-recover`}>恢复</span>}
      loading={recovering}
      onChange={(event) => setManualId(event.target.value)}
      onSearch={submitManual}
    />
    <Button data-testid={`${kind}-job-refresh`} size="small" aria-label={`刷新${kindLabel}任务`} icon={<ReloadOutlined />} disabled={!activeId || recovering} onClick={() => onRecover(activeId)} />
  </div>
}
