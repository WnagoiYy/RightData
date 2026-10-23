import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Modal, Space, Spin } from 'antd';
import { native } from '../lib/api';
import { Failure, fileSize } from './Feedback';

type UpdateStatus = { available: boolean; currentVersion: string; version?: string; size?: number; source?: 'internal' | 'public' | 'github'; notes?: string; configured: boolean; platform?: 'windows' | 'macos'; arch?: string };

export function UpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<string>();
  const check = async () => {
    setBusy(true); setError(undefined); setVerified(undefined);
    try { setStatus(await native<UpdateStatus>('client_update_check')); }
    catch (cause) { setStatus(undefined); setError(cause); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open) void check(); }, [open]);
  const download = async () => {
    if (!status?.version) return;
    setBusy(true); setError(undefined);
    try { const result = await native<{ verified: boolean; version: string }>('client_update_download', { request: { version: status.version } }); if (result.verified) setVerified(result.version); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  const install = () => {
    if (!verified) return;
    Modal.confirm({ title: `安装 ${verified}？`, content: status?.platform === 'macos' ? '打开磁盘映像后，请退出客户端，再将应用拖入 Applications 并替换旧版本。' : '安装程序将更新客户端和网络服务。请先保存正在编辑的内容。', okText: status?.platform === 'macos' ? '打开安装包' : '启动安装', cancelText: '取消', onOk: async () => {
      setBusy(true); setError(undefined);
      try { await native('client_update_install', { request: { version: verified } }); onClose(); }
      catch (cause) { setError(cause); }
      finally { setBusy(false); }
    } });
  };
  return <Modal title="客户端更新" open={open} onCancel={onClose} footer={<Space><Button onClick={() => void check()} disabled={busy}>重新检查</Button>{status?.available && <Button type="primary" disabled={!status.configured} loading={busy} onClick={() => verified ? install() : void download()}>{verified ? '安装更新' : '下载并校验'}</Button>}</Space>}>
    <Failure error={error} />
    {busy && !status ? <Spin /> : status && <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions column={1} size="small" items={[{ key: 'current', label: '当前版本', children: status.currentVersion }, ...(status.available ? [{ key: 'latest', label: '可用版本', children: status.version }, { key: 'size', label: '安装包', children: status.size ? fileSize(status.size) : '—' }, { key: 'source', label: '来源', children: status.source === 'github' ? 'GitHub Releases' : status.source === 'public' ? '公网发布源' : '内网发布源' }] : [])]} />
      {!status.available && <span>当前已是最新版本</span>}
      {status.available && !status.configured && <Alert type="warning" title="发布验证未配置，暂不能安装更新" />}
      {verified && <Alert type="success" title="安装包签名和完整性校验通过" />}
      {status.notes && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{status.notes}</p>}
    </Space>}
  </Modal>;
}
