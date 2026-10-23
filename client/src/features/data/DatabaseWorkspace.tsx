import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { UploadFile as AntUploadFile } from 'antd/es/upload/interface'
import {
  CloudUploadOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileProtectOutlined,
  HddOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { encodePath, errorMessage, formatBytes, hasPermission, parseJobProgress, settleOperation, stableOperation } from './data-utils'
import type { DataFeatureProps, DataFile, DataJob, JobState } from './types'
import { JobRecoveryControls, useRecoverableJob } from './job-recovery'
import './data-workspace.css'

type FileFilter = 'all' | 'business' | 'backup'

const terminalStates = new Set<JobState>(['succeeded', 'failed', 'canceled', 'expired'])

function duckdbName(value: string): string {
  const name = value.trim()
  return name.toLocaleLowerCase().endsWith('.duckdb') ? name : `${name}.duckdb`
}

export function DatabaseWorkspace({ api, permissions, taskScope }: DataFeatureProps) {
  const { message } = App.useApp()
  const [files, setFiles] = useState<DataFile[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<FileFilter>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [createSaving, setCreateSaving] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [revealedPassword, setRevealedPassword] = useState('')
  const [passwordFile, setPasswordFile] = useState<DataFile | null>(null)
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [createForm] = Form.useForm<{ name: string; password: string }>()
  const [uploadForm] = Form.useForm<{ name: string; password: string }>()

  const canManage = hasPermission(permissions, 'datasets.manage')
  const canRevealPassword = hasPermission(permissions, 'datasets.password')
  const canDownload = hasPermission(permissions, 'datasets.download')
  const canReadJobs = hasPermission(permissions, 'jobs.read')

  const loadFiles = useCallback(async (signal?: AbortSignal) => {
    if (!canManage) return
    setLoading(true)
    try {
      const response = await api.request<{ items: DataFile[] }>('/api/v1/data-files', { signal })
      setFiles(response.items ?? [])
    } catch (error) {
      if (!signal?.aborted) message.error(errorMessage(error))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [api, canManage, message])
  const reportJobError = useCallback((value: string) => { message.error(value) }, [message])
  const refreshFilesAfterBackup = useCallback((job: DataJob) => {
    if (job.state === 'succeeded') void loadFiles()
  }, [loadFiles])
  const {
    job: backupJob,
    references: backupJobReferences,
    activeId: activeBackupJobId,
    activeReference: activeBackupReference,
    recovering: recoveringBackupJob,
    recover: refreshBackupJob,
    rememberSubmitted: rememberSubmittedBackup,
  } = useRecoverableJob({
    api,
    canReadJobs,
    kind: 'backup',
    taskScope,
    fallbackLabel: '数据库',
    onError: reportJobError,
    onRecovered: refreshFilesAfterBackup,
  })

  useEffect(() => {
    const controller = new AbortController()
    void loadFiles(controller.signal)
    return () => controller.abort()
  }, [loadFiles])

  const createDatabase = async () => {
    const values = await createForm.validateFields()
    setCreateSaving(true)
    try {
      await api.request('/api/v1/data-files', {
        method: 'POST',
        body: { name: duckdbName(values.name), password: values.password || '' },
      })
      message.success('数据库已创建')
      setCreateOpen(false)
      createForm.resetFields()
      await loadFiles()
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setCreateSaving(false)
    }
  }

  const uploadDatabase = async () => {
    if (!uploadFile) {
      message.warning('请选择 DuckDB 文件')
      return
    }
    const values = await uploadForm.validateFields()
    setUploading(true)
    try {
      await api.upload('/api/v1/data-files/upload', uploadFile, {
        fields: { name: duckdbName(values.name), password: values.password },
      })
      message.success('数据库文件已上传')
      setUploadOpen(false)
      setUploadFile(null)
      uploadForm.resetFields()
      await loadFiles()
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setUploading(false)
    }
  }

  const revealPassword = async (file: DataFile) => {
    setPasswordFile(file)
    setRevealedPassword('')
    setPasswordOpen(true)
    setPasswordLoading(true)
    try {
      const response = await api.request<{ password: string }>(`/api/v1/data-files/${encodePath(file.id)}/password`)
      setRevealedPassword(response.password)
    } catch (error) {
      message.error(errorMessage(error))
      setPasswordOpen(false)
    } finally {
      setPasswordLoading(false)
    }
  }

  const createBackup = async (file: DataFile) => {
    const operation = stableOperation('backup', { fileId: file.id })
    try {
      const response = await api.request<{ jobId: string; state: JobState }>(`/api/v1/data-files/${encodePath(file.id)}/backups`, {
        method: 'POST',
        idempotencyKey: operation.key,
      })
      settleOperation(operation)
      const submitted = {
        id: response.jobId,
        kind: 'backup',
        datasetId: file.id,
        state: response.state,
        progress: { phase: response.state },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: '',
      } satisfies DataJob
      rememberSubmittedBackup(submitted, file.name)
      message.success('备份任务已提交')
      if (canReadJobs) await refreshBackupJob(response.jobId)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const downloadDatabase = async (file: DataFile) => {
    try {
      await api.download(`/api/v1/data-files/${encodePath(file.id)}/download`, file.name)
      message.success('数据库文件已保存')
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const visibleFiles = useMemo(() => filter === 'all' ? files : files.filter((file) => file.kind === filter), [files, filter])
  const businessCount = files.filter((file) => file.kind === 'business').length
  const backupCount = files.filter((file) => file.kind === 'backup').length

  const columns: ColumnsType<DataFile> = [
    {
      title: '数据库文件',
      dataIndex: 'name',
      minWidth: 240,
      render: (name, file) => <div className="rd-database-name">
        <span className={`kind-${file.kind}`}>{file.kind === 'backup' ? <FileProtectOutlined /> : <DatabaseOutlined />}</span>
        <span><b>{name}</b><small>{file.id}</small></span>
      </div>,
    },
    { title: '类型', dataIndex: 'kind', width: 96, render: (kind) => kind === 'backup' ? <Tag color="gold">备份</Tag> : <Tag color="blue">业务库</Tag> },
    { title: '大小', dataIndex: 'size', width: 100, align: 'right', render: formatBytes },
    { title: '连接', dataIndex: 'connections', width: 180, render: (connections: DataFile['connections']) => connections.length ? <Space size={[3, 3]} wrap>{connections.map((connection) => <Tag key={connection.id}>{connection.name}</Tag>)}</Space> : <span className="rd-muted">未注册连接</span> },
    { title: '创建时间', dataIndex: 'createdAt', width: 172, render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }) },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 190,
      render: (_value, file) => <Space size={1}>
        {file.kind === 'business' && <Tooltip title="创建一致性备份"><Button type="text" size="small" icon={<SafetyCertificateOutlined />} disabled={Boolean(backupJob && !terminalStates.has(backupJob.state))} onClick={() => void createBackup(file)}>备份</Button></Tooltip>}
        {canRevealPassword && <Tooltip title="查看数据库密码"><Button type="text" size="small" icon={<EyeOutlined />} onClick={() => void revealPassword(file)}>密码</Button></Tooltip>}
        {canDownload && <Tooltip title="保存数据库文件"><Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => void downloadDatabase(file)}>下载</Button></Tooltip>}
      </Space>,
    },
  ]

  if (!canManage) {
    return <div className="rd-workspace rd-permission-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有数据库运维权限" /></div>
  }

  const progress = parseJobProgress(backupJob?.progress)
  const uploadList: AntUploadFile[] = uploadFile ? [{ uid: uploadFile.name, name: uploadFile.name, status: 'done', size: uploadFile.size }] : []

  return <section className="rd-workspace rd-database-workspace">
    <div className="rd-toolbar">
      <div className="rd-database-filter">
        <Segmented<FileFilter>
          value={filter}
          options={[
            { value: 'all', label: `全部 ${files.length}` },
            { value: 'business', label: `业务库 ${businessCount}` },
            { value: 'backup', label: `备份 ${backupCount}` },
          ]}
          onChange={setFilter}
        />
      </div>
      <Space size={6}>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadFiles()}>刷新</Button>
        <Button icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>上传数据库</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建数据库</Button>
      </Space>
    </div>

    {canReadJobs && <JobRecoveryControls
      kind="backup"
      kindLabel="备份"
      references={backupJobReferences}
      activeId={activeBackupJobId}
      recovering={recoveringBackupJob}
      onRecover={(id, label) => { void refreshBackupJob(id, label) }}
    />}

    {backupJob && <div className={`rd-job-strip rd-backup-job state-${backupJob.state}`} data-testid="backup-job-status" data-state={backupJob.state} data-job-id={backupJob.id}>
      <div className="rd-job-icon">{terminalStates.has(backupJob.state) ? <FileProtectOutlined /> : <LoadingOutlined spin />}</div>
      <div className="rd-job-main">
        <div><b>{activeBackupReference?.label ?? '数据库'} · 备份</b><Tag>{backupJob.state}</Tag><code>{backupJob.id}</code></div>
        <Progress size="small" percent={progress.percent ?? (backupJob.state === 'succeeded' ? 100 : undefined)} status={backupJob.state === 'failed' ? 'exception' : backupJob.state === 'succeeded' ? 'success' : 'active'} />
        <small>{backupJob.error || `阶段：${progress.phase}`}</small>
      </div>
    </div>}

    <div className="rd-database-table">
      <Table<DataFile>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={visibleFiles}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 个文件` }}
        scroll={{ x: 1040 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据库文件" /> }}
      />
    </div>

    <Modal open={createOpen} title="新建数据库" okText="创建" cancelText="取消" confirmLoading={createSaving} onCancel={() => setCreateOpen(false)} onOk={() => void createDatabase()}>
      <Form form={createForm} layout="vertical" initialValues={{ password: '' }}>
        <Form.Item name="name" label="文件名称" rules={[{ required: true, message: '请输入文件名称' }]} extra="未填写扩展名时自动添加 .duckdb"><Input prefix={<HddOutlined />} placeholder="例如 sales.duckdb" /></Form.Item>
        <Form.Item name="password" label="数据库密码"><Input.Password placeholder="留空时由服务端生成" /></Form.Item>
      </Form>
    </Modal>

    <Modal open={uploadOpen} title="上传数据库" okText="上传" cancelText="取消" confirmLoading={uploading} onCancel={() => { setUploadOpen(false); setUploadFile(null) }} onOk={() => void uploadDatabase()}>
      <Form form={uploadForm} layout="vertical">
        <Form.Item label="DuckDB 文件" required>
          <Upload.Dragger accept=".duckdb" maxCount={1} fileList={uploadList} beforeUpload={(file) => {
            setUploadFile(file)
            uploadForm.setFieldValue('name', file.name)
            return Upload.LIST_IGNORE
          }} onRemove={() => { setUploadFile(null); return true }}>
            <CloudUploadOutlined className="rd-upload-database-icon" />
            <b>选择加密 DuckDB 文件</b>
          </Upload.Dragger>
        </Form.Item>
        <Form.Item name="name" label="保存名称" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="password" label="数据库密码" rules={[{ required: true, message: '上传已有数据库必须提供密码' }]}><Input.Password /></Form.Item>
      </Form>
    </Modal>

    <Modal open={passwordOpen} title="数据库密码" footer={<Button onClick={() => setPasswordOpen(false)}>关闭</Button>} onCancel={() => setPasswordOpen(false)}>
      <div className="rd-password-view">
        <DatabaseOutlined />
        <span><b>{passwordFile?.name}</b><small>仅在确有运维需要时使用</small></span>
      </div>
      <div className="rd-password-value">
        {passwordLoading ? <LoadingOutlined spin /> : <Typography.Text code copyable={{ icon: [<CopyOutlined key="copy" />, <CopyOutlined key="copied" />] }}>{revealedPassword}</Typography.Text>}
      </div>
    </Modal>
  </section>
}
