import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Table } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { errorMessage, type Api } from '../../lib/api';
import { dateTime, Failure } from '../../components/Feedback';

type Connection = { id: string; name: string; fileId: string; createdAt: string };
type DataFile = { id: string; name: string; kind: string };
export function ConnectionsWorkspace({ api }: { api: Api }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<Connection[]>([]);
  const [files, setFiles] = useState<DataFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<unknown>();
  const [editing, setEditing] = useState<Connection | 'new'>();
  const [form] = Form.useForm();
  const load = useCallback(async () => { setBusy(true); setError(undefined); try {
    const [connections, dataFiles] = await Promise.all([api.request<{ items: Connection[] }>('/api/v1/connections'), api.request<{ items: DataFile[] }>('/api/v1/data-files')]);
    setItems(connections.items); setFiles(dataFiles.items);
  } catch (cause) { setItems([]); setError(cause); } finally { setBusy(false); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  const edit = (item: Connection | 'new') => { setEditing(item); form.resetFields(); if (item !== 'new') form.setFieldsValue(item); };
  const save = async () => { const values = await form.validateFields(); setSaving(true); try {
    await api.request(editing === 'new' ? '/api/v1/connections' : `/api/v1/connections/${encodeURIComponent((editing as Connection).id)}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: values });
    setEditing(undefined); message.success('连接已保存'); await load();
  } catch (cause) { message.error(errorMessage(cause)); } finally { setSaving(false); } };
  const remove = async (item: Connection) => { try { await api.request(`/api/v1/connections/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); message.success('连接已解绑'); await load(); } catch (cause) { message.error(errorMessage(cause)); } };
  return <div className="workspace-stack">
    <div className="toolbar"><Input.Search placeholder="查找连接" aria-label="查找连接" allowClear value={search} onChange={event => setSearch(event.target.value)} className="search-input" /><div className="toolbar-spacer" /><Button icon={<ReloadOutlined />} loading={busy} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => edit('new')}>登记连接</Button></div>
    <Failure error={error} retry={() => void load()} />
    <Table rowKey="id" size="small" loading={busy} dataSource={items.filter(item => item.name.includes(search))} columns={[
      { title: '连接名称', dataIndex: 'name' }, { title: '数据库文件', dataIndex: 'fileId', render: (id: string) => files.find(file => file.id === id)?.name || id },
      { title: '创建时间', dataIndex: 'createdAt', render: dateTime, width: 190 },
      { title: '操作', width: 150, render: (_, item) => <Space><Button type="link" size="small" onClick={() => edit(item)}>重命名</Button><Popconfirm title="解绑此连接？" description="数据库文件会保留，引用此连接的查询将不可用。" onConfirm={() => remove(item)}><Button type="link" danger size="small">解绑</Button></Popconfirm></Space> },
    ]} />
    <Modal title={editing === 'new' ? '登记连接' : '重命名连接'} open={!!editing} onCancel={() => setEditing(undefined)} onOk={() => void save()} confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical"><Form.Item name="name" label="连接名称" rules={[{ required: true }]}><Input /></Form.Item>
        {editing === 'new' && <Form.Item name="fileId" label="数据库文件" rules={[{ required: true }]}><Select options={files.filter(file => file.kind === 'business').map(file => ({ value: file.id, label: file.name }))} /></Form.Item>}
      </Form>
    </Modal>
  </div>;
}
