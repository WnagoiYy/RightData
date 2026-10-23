import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Space, Table, Upload } from 'antd';
import { DownloadOutlined, FileOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { errorMessage, hasPermission, type Api } from '../../lib/api';
import { dateTime, Failure, fileSize } from '../../components/Feedback';

type StoredFile = { id: string; name: string; ownerId: string; size: number; mediaType: string; sha256: string; updatedAt: string };
export function FilesWorkspace({ api, permissions }: { api: Api; permissions: string[] }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<StoredFile[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [editing, setEditing] = useState<StoredFile>();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const writable = hasPermission(permissions, 'files.write');
  const load = useCallback(async () => { setBusy(true); setError(undefined); try { setItems((await api.request<{ items: StoredFile[] }>('/api/v1/files')).items); } catch (cause) { setItems([]); setError(cause); } finally { setBusy(false); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  const upload = async (file: File) => { setUploading(true); setError(undefined); try { await api.upload('/api/v1/files', file); message.success('文件已上传'); await load(); } catch (cause) { setError(cause); } finally { setUploading(false); } };
  const remove = async (file: StoredFile) => { try { await api.request(`/api/v1/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); message.success('文件已删除'); await load(); } catch (cause) { setError(cause); } };
  const download = async (file: StoredFile) => { try { await api.download(`/api/v1/files/${encodeURIComponent(file.id)}/download`, file.name); message.success('文件已保存'); } catch (cause) { message.error(errorMessage(cause)); } };
  const rename = async () => { if (!editing) return; const values = await form.validateFields(); setSaving(true); try { await api.request(`/api/v1/files/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: { name: values.name } }); setEditing(undefined); await load(); } catch (cause) { message.error(errorMessage(cause)); } finally { setSaving(false); } };
  return <div className="workspace-stack">
    <div className="toolbar"><Input.Search placeholder="查找文件" aria-label="查找文件" allowClear value={search} onChange={event => setSearch(event.target.value)} className="search-input" /><span className="muted">{items.length} 个文件</span><div className="toolbar-spacer" /><Button icon={<ReloadOutlined />} loading={busy} onClick={() => void load()}>刷新</Button>{writable && <Upload showUploadList={false} beforeUpload={file => { void upload(file); return false; }}><Button type="primary" icon={<UploadOutlined />} loading={uploading}>上传文件</Button></Upload>}</div>
    <Failure error={error} retry={() => void load()} />
    <Table rowKey="id" size="small" loading={busy} dataSource={items.filter(item => item.name.toLowerCase().includes(search.toLowerCase()))} scroll={{ x: 720 }} columns={[
      { title: '文件名称', dataIndex: 'name', render: (name: string) => <Space><FileOutlined className="muted" />{name}</Space> },
      { title: '大小', dataIndex: 'size', render: fileSize, width: 100 }, { title: '类型', dataIndex: 'mediaType', ellipsis: true, width: 170 },
      { title: '更新时间', dataIndex: 'updatedAt', render: dateTime, width: 190 },
      { title: '操作', width: writable ? 230 : 95, render: (_, item) => <Space><Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => void download(item)}>下载</Button>{writable && <><Button type="link" size="small" onClick={() => { setEditing(item); form.setFieldsValue(item); }}>重命名</Button><Popconfirm title={`删除“${item.name}”？`} onConfirm={() => remove(item)}><Button type="link" danger size="small">删除</Button></Popconfirm></>}</Space> },
    ]} />
    <Modal title="重命名文件" open={!!editing} onCancel={() => setEditing(undefined)} onOk={() => void rename()} confirmLoading={saving}><Form form={form} layout="vertical"><Form.Item name="name" label="文件名" rules={[{ required: true }]}><Input /></Form.Item></Form></Modal>
  </div>;
}
