import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Descriptions, Form, Input, Modal, Space, Switch, Tag } from 'antd';
import { ApiError, native, type ConnectionSettings, type TransportState } from '../lib/api';
import { Failure } from './Feedback';

export const initialConnection: ConnectionSettings = { serverUrl: 'http://127.0.0.1:8003', discoveryUrl: '', allowPublicRelay: false };
type NetworkService = { running: boolean; enabled: boolean; autoStart: boolean; deviceId: string; mode: string; ready: boolean };
export function ConnectionDialog({ open, state, onClose, onChange }: { open: boolean; state?: TransportState; onClose: () => void; onChange: (state: TransportState) => void }) {
  const startupLabel = /Macintosh|Mac OS X/.test(navigator.userAgent) ? '登录时启动' : '开机启动';
  const [form] = Form.useForm<ConnectionSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [service, setService] = useState<NetworkService>();
  const [serviceError, setServiceError] = useState<unknown>();
  const [serviceBusy, setServiceBusy] = useState(false);
  const formInitialized = useRef(false);
  useEffect(() => { let active = true; if (open) { setServiceError(undefined); void native<NetworkService>('network_service_get_state').then(value => { if (active) setService(value); }).catch(cause => { if (active) { setService(undefined); setServiceError(cause); } }); } return () => { active = false; }; }, [open]);
  const changeService = async (command: string, request: Record<string, boolean>) => {
    setServiceBusy(true); setServiceError(undefined);
    try { setService(await native<NetworkService>(command, { request })); onChange(await native<TransportState>('transport_get_state')); }
    catch (cause) { setServiceError(cause); }
    finally { setServiceBusy(false); }
  };
  useEffect(() => {
    if (!open) { formInitialized.current = false; return; }
    if (!formInitialized.current) { form.setFieldsValue(state?.settings || initialConnection); setError(undefined); formInitialized.current = true; }
  }, [open, state, form]);
  const save = async (rebindInstance = false) => {
    const values = await form.validateFields();
    setBusy(true); setError(undefined);
    try { const result = await native<TransportState>('transport_configure', { request: { ...values, serverUrl: values.serverUrl.trim(), discoveryUrl: values.discoveryUrl?.trim() || undefined, rebindInstance } }); onChange(result); onClose(); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <Modal title="连接设置" open={open} onCancel={onClose} destroyOnHidden footer={<Space><Button onClick={onClose}>取消</Button><Button type="primary" loading={busy} onClick={() => void save()}>保存并连接</Button></Space>}>
    <Form form={form} layout="vertical" initialValues={initialConnection} className="connection-form">
      <Form.Item name="serverUrl" label="服务端地址" rules={[{ required: true, message: '请输入服务端地址' }, { type: 'url', message: '请输入完整的 HTTP 或 HTTPS 地址' }]}><Input placeholder="http://127.0.0.1:8003" /></Form.Item>
      <Form.Item name="discoveryUrl" label="节点发现地址" rules={[{ type: 'url', message: '请输入完整的 HTTP 或 HTTPS 地址' }]}><Input placeholder="https://discovery.example.com" /></Form.Item>
      <Form.Item name="allowPublicRelay" valuePropName="checked"><Checkbox>允许公网业务中继</Checkbox></Form.Item>
    </Form>
    {state?.connection && <Descriptions size="small" column={1} items={[
      { key: 'status', label: '当前连接', children: <Tag color={state.connection.ready ? 'green' : 'default'}>{state.connection.mode === 'direct' && state.connection.ready ? '内网直连' : state.connection.mode === 'peer' ? '内网节点中转' : '未连接'}</Tag> },
      ...(state.connection.instanceId ? [{ key: 'instance', label: '服务实例', children: <span className="mono">{state.connection.instanceId}</span> }] : []),
    ]} />}
    {state?.connection.lastError && !error && <Alert type="warning" showIcon title={state.connection.lastError} />}
    {service && <Descriptions size="small" column={1} items={[
      { key: 'service', label: '本机网络服务', children: <Space><Tag color={service.enabled ? 'green' : 'default'}>{service.enabled ? '运行中' : '已暂停'}</Tag><Button size="small" loading={serviceBusy} onClick={() => void changeService('network_service_set_enabled', { enabled: !service.enabled })}>{service.enabled ? '暂停' : '启动'}</Button></Space> },
      { key: 'startup', label: startupLabel, children: <Switch aria-label={`网络服务${startupLabel}`} checked={service.autoStart} loading={serviceBusy} onChange={autoStart => void changeService('network_service_set_autostart', { autoStart })} /> },
    ]} />}
    {!!serviceError && <Failure error={serviceError} />}
    <Failure error={error} />
    {error instanceof ApiError && error.code === 'instance_mismatch' && <Button danger loading={busy} onClick={() => Modal.confirm({ title: '切换服务实例', content: '将清除当前登录和预览内容，连接此地址上的新服务。', okText: '切换并重新登录', cancelText: '取消', onOk: () => save(true) })}>绑定新的服务实例</Button>}
  </Modal>;
}
