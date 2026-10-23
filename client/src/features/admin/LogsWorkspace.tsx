import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Input, Select, Space, Spin, Table, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { native, type Api } from '../../lib/api';
import { dateTime, Failure } from '../../components/Feedback';
import type { DataJob } from '../data/types';

type Log = { id: string; createdAt: string; actorId: string; category?: string; action?: string; target?: string; outcome: string; durationMs?: number; requestId?: string; datasetId?: string; source?: string; kind?: string; sqlTemplate?: string; receivedAt?: string; applied?: boolean };
type ClientEvent = { eventId: string; occurredAt: string; actorId: string; action: string; targetId: string; outcome: string; receivedAt: string; applied: boolean };
type QueueStatus = { pending: number; rejected: number; lastError?: string };
const taskStates: Record<string, string> = { queued: '排队中', running: '处理中', succeeded: '已完成', failed: '失败', canceled: '已取消', expired: '已过期' };

function JobLogDetails({ api, item }: { api: Api; item: Log }) {
  const [job, setJob] = useState<DataJob>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setJob(undefined); setError(undefined); setBusy(true);
    void api.request<DataJob>(`/api/v1/jobs/${encodeURIComponent(item.target || '')}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setJob(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, item.target]);
  return <div className="workspace-stack"><Spin spinning={busy}><Failure error={error} />{job && <Descriptions size="small" column={2} items={[
    { key: 'state', label: '任务状态', children: taskStates[job.state] || job.state },
    { key: 'id', label: '任务标识', children: job.id },
    ...(job.result ? [{ key: 'result', label: '处理结果', span: 2, children: <pre className="log-details">{JSON.stringify(job.result, null, 2)}</pre> }] : []),
    ...(job.error ? [{ key: 'error', label: '任务错误', span: 2, children: <pre className="log-details">{JSON.stringify(job.error, null, 2)}</pre> }] : []),
  ]} />}</Spin><pre className="log-details">{JSON.stringify(item, null, 2)}</pre></div>;
}

export function LogsWorkspace({ api, category, permissions = [] }: { api: Api; category: 'access' | 'relay' | 'query' | 'import' | 'export'; permissions?: string[] }) {
  const [items, setItems] = useState<Log[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [filter, setFilter] = useState('');
  const [outcome, setOutcome] = useState<string>();
  const [exportStage, setExportStage] = useState('server');
  const [queue, setQueue] = useState<QueueStatus>();
  const generation = useRef(0);
  const load = useCallback(async () => { const version = ++generation.current; setBusy(true); setError(undefined); setItems([]); try {
    const isTaskLog = category === 'import' || category === 'export' && exportStage === 'server';
    const path = category === 'query' ? '/api/v1/query-logs' : `/api/v1/logs?category=${isTaskLog ? 'job' : category}`;
    const result = category === 'relay' ? await native<{ items: Log[] }>('transport_get_logs', { request: { limit: 50, offset: page * 50 } }) : category === 'export' && exportStage === 'client' ? { items: (await api.request<{ items: ClientEvent[] }>(`/api/v1/client-events?category=client_export&limit=50&offset=${page * 50}`)).items.map(item => ({ ...item, id: item.eventId, createdAt: item.occurredAt, target: item.targetId })) } : await api.request<{ items: Log[] }>(`${path}${path.includes('?') ? '&' : '?'}limit=50&offset=${page * 50}`);
    if (version === generation.current) {
      setHasNext(result.items.length === 50);
      setItems(isTaskLog ? result.items.filter(item => category === 'import' ? item.action === 'submit_import' : item.action === 'submit_export' || item.action === 'download') : result.items);
    }
    if (category === 'export') { const status = await native<QueueStatus>('export_event_status'); if (version === generation.current) setQueue(status); }
  } catch (cause) { if (version === generation.current) setError(cause); } finally { if (version === generation.current) setBusy(false); } }, [api, category, page, exportStage]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const filtered = items.filter(item => (!outcome || (outcome === 'success' ? ['success', 'ok'].includes(item.outcome) : !['success', 'ok'].includes(item.outcome))) && (!filter || JSON.stringify(item).toLowerCase().includes(filter.toLowerCase())));
  return <div className="workspace-stack">
    <div className="toolbar">{category === 'export' && <Select aria-label="导出阶段" value={exportStage} onChange={value => { setExportStage(value); setPage(0); }} options={[{ value: 'server', label: '服务端取数' }, { value: 'client', label: '本地文件生成' }]} style={{ width: 150 }} />}<Input.Search allowClear placeholder="筛选当前页日志" aria-label="筛选当前页日志" value={filter} onChange={event => setFilter(event.target.value)} className="search-input" /><Select aria-label="执行结果" placeholder="全部结果" allowClear value={outcome} onChange={setOutcome} options={[{ value: 'success', label: '成功' }, { value: 'failed', label: '异常' }]} style={{ width: 120 }} /><div className="toolbar-spacer" /><Button icon={<ReloadOutlined />} loading={busy} onClick={() => void load()}>刷新</Button></div>
    {category === 'export' && queue && (queue.pending > 0 || queue.rejected > 0 || queue.lastError) && <Alert type={queue.rejected || queue.lastError ? 'warning' : 'info'} title={[queue.pending ? `${queue.pending} 条导出结果待补报` : '', queue.rejected ? `${queue.rejected} 条补报被拒绝` : '', queue.lastError || ''].filter(Boolean).join('；')} />}
    <Failure error={error} retry={() => void load()} />
    <Table rowKey="id" size="small" loading={busy} dataSource={filtered} pagination={false} scroll={{ x: 960 }} columns={[
      { title: '时间', dataIndex: 'createdAt', render: dateTime, width: 180 }, ...(category === 'relay' ? [{ title: '连接方式', dataIndex: 'mode', width: 120, render: (value: string) => ({ direct: '内网直连', peer: '节点中转', public_relay: '公网中继' } as Record<string, string>)[value] || value }] : [{ title: '用户', dataIndex: 'actorId', ellipsis: true, width: 120 }]),
      ...(category === 'query' ? [{ title: '来源', dataIndex: 'source', width: 100 }, { title: '查询', dataIndex: 'sqlTemplate', ellipsis: true }] : [{ title: '操作', dataIndex: 'action', width: 140, render: (value: string) => ({ submit_import: '提交导入', submit_export: '提交导出', download: '下载结果' } as Record<string, string>)[value] || value }, { title: '目标', dataIndex: 'target', ellipsis: true }]),
      { title: '结果', dataIndex: 'outcome', width: 100, render: (value: string, item: Log) => <Tag color={['ok', 'success'].includes(value) ? 'green' : value === 'canceled' ? 'default' : 'red'}>{['ok', 'success'].includes(value) && item.action?.startsWith('submit_') ? '提交成功' : ({ ok: '成功', success: '成功', failed: '失败', canceled: '已取消' } as Record<string, string>)[value] || value}</Tag> },
      ...(category === 'export' && exportStage === 'client' ? [{ title: '收到时间', dataIndex: 'receivedAt', render: dateTime, width: 180 }, { title: '最终结果', dataIndex: 'applied', width: 100, render: (value: boolean) => value ? '已采纳' : '较早事件' }] : [{ title: '耗时', dataIndex: 'durationMs', width: 90, render: (value?: number) => value === undefined ? '—' : `${value} ms` }, { title: '请求标识', dataIndex: 'requestId', ellipsis: true, width: 180 }]),
    ]} expandable={{ expandedRowRender: item => item.category === 'job' && item.target && (permissions.includes('*') || permissions.includes('jobs.read')) ? <JobLogDetails api={api} item={item} /> : <pre className="log-details">{JSON.stringify(item, null, 2)}</pre> }} />
    <div className="page-controls"><Space><Button disabled={page === 0 || busy} onClick={() => setPage(value => value - 1)}>上一页</Button><span>第 {page + 1} 页</span><Button disabled={!hasNext || busy} onClick={() => setPage(value => value + 1)}>下一页</Button></Space></div>
  </div>;
}
