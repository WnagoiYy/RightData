import { Alert, Button } from 'antd';
import { ApiError, errorMessage } from '../lib/api';

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return <Alert type="error" showIcon title={errorMessage(error)} description={error instanceof ApiError && error.requestId ? `请求标识：${error.requestId}` : undefined}
    action={retry && <Button size="small" onClick={retry}>重试</Button>} />;
}
export function dateTime(value: string | undefined) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
export function fileSize(bytes: number) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`; }
