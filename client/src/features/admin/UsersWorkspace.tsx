import { useCallback, useEffect, useState } from 'react';
import { App, Button, Checkbox, Drawer, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Api, User } from '../../lib/api';
import { errorMessage } from '../../lib/api';
import { Failure } from '../../components/Feedback';

const permissionNames: Record<string, string> = {
  '*': '实例管理员', 'data.read': '数据查询', 'data.write': '数据写入', 'data.export': '数据导出',
  'schema.manage': '表结构管理', 'sql.execute': 'SQL 执行', 'datasets.manage': '数据库与连接管理',
  'datasets.password': '数据库密码', 'datasets.download': '数据库下载', 'files.read': '文件读取',
  'files.write': '文件管理', 'jobs.read': '任务查看', 'jobs.cancel': '任务取消', 'config.read': '查询定义读取',
  'config.write': '配置管理', 'resources.read': '报表看板查看', 'docs.read': '接口文档',
  'logs.read': '系统日志', 'users.manage': '用户授权', 'system.manage': '系统运维',
};
type Grant = { datasetId: string; table: string; operations: string[]; columns: string[]; rowFilter?: unknown };

export function UsersWorkspace({ api, currentUser }: { api: Api; currentUser: User }) {
  const { message } = App.useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [editing, setEditing] = useState<User | 'new'>();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [grantUser, setGrantUser] = useState<User>();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [grantForm] = Form.useForm();
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [grantError, setGrantError] = useState<unknown>();
  const load = useCallback(async () => { setBusy(true); setError(undefined); try { setUsers((await api.request<{ items: User[] }>('/api/v1/users')).items); } catch (cause) { setUsers([]); setError(cause); } finally { setBusy(false); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  const edit = (user: User | 'new') => { setEditing(user); form.resetFields(); if (user !== 'new') form.setFieldsValue(user); };
  const save = async () => {
    const values = await form.validateFields(); setSaving(true);
    try {
      await api.request(editing === 'new' ? '/api/v1/users' : `/api/v1/users/${encodeURIComponent((editing as User).id)}`, { method: editing === 'new' ? 'POST' : 'PUT', body: values });
      setEditing(undefined); message.success('用户已保存'); await load();
    } catch (cause) { message.error(errorMessage(cause)); } finally { setSaving(false); }
  };
  const openGrants = async (user: User) => {
    setGrantUser(user); setGrants([]); setGrantError(undefined); grantForm.resetFields();
    try { const [list, dbs] = await Promise.all([api.request<{ items: Grant[] }>(`/api/v1/users/${encodeURIComponent(user.id)}/grants`), api.request<{ datasets: { id: string; name: string }[] }>('/api/v1/datasets')]); setGrants(list.items); setDatasets(dbs.datasets); }
    catch (cause) { setGrantError(cause); }
  };
  const saveGrant = async () => {
    const values = await grantForm.validateFields(); if (!grantUser) return;
    setSaving(true); setGrantError(undefined);
    try {
      const rowFilter = values.rowFilter?.trim() ? JSON.parse(values.rowFilter) : null;
      await api.request(`/api/v1/users/${encodeURIComponent(grantUser.id)}/grants`, { method: 'PUT', body: { ...values, rowFilter, columns: values.columns || ['*'], operations: values.operations || [] } });
      const list = await api.request<{ items: Grant[] }>(`/api/v1/users/${encodeURIComponent(grantUser.id)}/grants`); setGrants(list.items); message.success('数据授权已保存');
    } catch (cause) { setGrantError(cause); } finally { setSaving(false); }
  };
  return <div className="workspace-stack">
    <div className="toolbar"><Input.Search allowClear placeholder="查找用户" aria-label="查找用户" value={search} onChange={event => setSearch(event.target.value)} className="search-input" /><div className="toolbar-spacer" /><Button icon={<ReloadOutlined />} onClick={() => void load()} loading={busy}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => edit('new')}>新建用户</Button></div>
    <Failure error={error} retry={() => void load()} />
    <Table rowKey="id" loading={busy} dataSource={users.filter(user => user.username.toLowerCase().includes(search.toLowerCase()))} size="small" pagination={{ pageSize: 15, showSizeChanger: false }} columns={[
      { title: '账号', dataIndex: 'username', width: 180 },
      { title: '权限', dataIndex: 'permissions', render: (permissions: string[]) => <Space size={[4, 4]} wrap>{permissions.map(permission => <Tag key={permission}>{permissionNames[permission] || permission}</Tag>)}</Space> },
      { title: '状态', dataIndex: 'disabled', width: 90, render: (disabled: boolean) => <Tag color={disabled ? 'default' : 'green'}>{disabled ? '已停用' : '正常'}</Tag> },
      { title: '操作', width: 180, render: (_, user) => <Space><Button type="link" size="small" disabled={currentUser.id === user.id} onClick={() => edit(user)}>编辑</Button><Button type="link" size="small" onClick={() => void openGrants(user)}>数据授权</Button></Space> },
    ]} />
    <Modal title={editing === 'new' ? '新建用户' : '编辑用户'} open={!!editing} onCancel={() => setEditing(undefined)} onOk={() => void save()} confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ permissions: ['data.read', 'resources.read'], disabled: false }}>
        <Form.Item name="username" label="账号" rules={[{ required: true }]}><Input disabled={editing !== 'new'} autoComplete="off" /></Form.Item>
        {editing === 'new' && <Form.Item name="password" label="初始密码" rules={[{ required: true }, { min: 12, message: '至少 12 个字符' }]}><Input.Password autoComplete="new-password" /></Form.Item>}
        <Form.Item name="permissions" label="功能权限"><Select mode="multiple" options={Object.entries(permissionNames).map(([value, label]) => ({ value, label }))} /></Form.Item>
        {editing !== 'new' && <Form.Item name="disabled" valuePropName="checked"><Checkbox>停用账号</Checkbox></Form.Item>}
      </Form>
    </Modal>
    <Drawer title={`${grantUser?.username || ''} · 数据授权`} open={!!grantUser} onClose={() => setGrantUser(undefined)} size={680}>
      <div className="workspace-stack"><Failure error={grantError} />
        <Table rowKey={grant => `${grant.datasetId}/${grant.table}`} dataSource={grants} size="small" pagination={false} columns={[
          { title: '数据集', dataIndex: 'datasetId', render: (id: string) => datasets.find(dataset => dataset.id === id)?.name || id }, { title: '表', dataIndex: 'table' },
          { title: '操作', dataIndex: 'operations', render: (ops: string[]) => ops.join(', ') || '无权限' },
          { title: '', width: 65, render: (_, grant) => <Button size="small" type="link" onClick={() => grantForm.setFieldsValue({ ...grant, rowFilter: grant.rowFilter ? JSON.stringify(grant.rowFilter, null, 2) : '' })}>编辑</Button> },
        ]} />
        <Form form={grantForm} layout="vertical" initialValues={{ table: '*', columns: ['*'], operations: ['read'] }}>
          <Form.Item name="datasetId" label="数据集" rules={[{ required: true }]}><Select options={datasets.map(dataset => ({ value: dataset.id, label: dataset.name }))} /></Form.Item>
          <Form.Item name="table" label="表名" rules={[{ required: true }]}><Input placeholder="* 表示全部表" /></Form.Item>
          <Form.Item name="operations" label="允许操作"><Checkbox.Group options={[{ value: 'read', label: '查询' }, { value: 'write', label: '写入' }, { value: 'export', label: '导出' }, { value: 'schema', label: '结构管理' }]} /></Form.Item>
          <Form.Item name="columns" label="允许字段"><Select mode="tags" tokenSeparators={[',']} placeholder="* 表示全部字段" /></Form.Item>
          <Form.Item name="rowFilter" label="行筛选（JSON）"><Input.TextArea rows={4} className="code-input" placeholder={'{"field":"地市","op":"eq","value":"贵阳"}'} /></Form.Item>
          <Button type="primary" loading={saving} onClick={() => void saveGrant()}>保存授权</Button>
        </Form>
      </div>
    </Drawer>
  </div>;
}
