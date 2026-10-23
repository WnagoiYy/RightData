import { useEffect, useState } from 'react';
import { Button, Empty, Tag } from 'antd';
import { ArrowRightOutlined, DatabaseOutlined, FileTextOutlined, TableOutlined } from '@ant-design/icons';
import { hasPermission, type Api, type TransportState, type User } from '../../lib/api';
import { Failure } from '../../components/Feedback';
import type { DynamicMenu } from '../../lib/navigation';

export function Overview({ api, user, state, menus, navigate }: { api: Api; user: User; state?: TransportState; menus: DynamicMenu[]; navigate: (page: string) => void }) {
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<unknown>();
  useEffect(() => { let active = true; if (hasPermission(user.permissions, 'data.read')) api.request<{ datasets: { id: string; name: string }[] }>('/api/v1/datasets').then(result => { if (active) setDatasets(result.datasets); }).catch(cause => { if (active) setError(cause); }); return () => { active = false; }; }, [api, user.permissions]);
  const resources = menus.filter(menu => menu.resourceId);
  return <div className="workspace-stack">
    <div className="overview-status"><div><span className="muted">当前账号</span><strong>{user.username}</strong></div><div><span className="muted">连接状态</span><Tag color={state?.connection.ready ? 'green' : 'default'}>{state?.connection.ready ? '内网直连' : '未连接'}</Tag></div><div className="overview-address"><span className="muted">服务端</span><span>{state?.settings.serverUrl || '—'}</span></div></div>
    <Failure error={error} />
    <div className="overview-grid"><section className="overview-panel"><div className="panel-toolbar"><strong>我的报表与看板</strong><span className="muted">{resources.length}</span></div>
      {resources.length ? <div className="resource-list">{resources.map(resource => <button key={resource.id} className="resource-row" onClick={() => navigate(`resource:${resource.id}`)}><FileTextOutlined /><span>{resource.name}</span><Tag>{({ report: '报表', dashboard: '看板', h5: '通报' } as Record<string, string>)[resource.resourceKind || '']}</Tag><ArrowRightOutlined /></button>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可访问的报表或看板" />}
    </section>{hasPermission(user.permissions, 'data.read') && <section className="overview-panel"><div className="panel-toolbar"><strong>可用数据集</strong><Button type="text" size="small" icon={<TableOutlined />} onClick={() => navigate('data')}>数据查询</Button></div>
      {datasets.length ? <div className="dataset-list">{datasets.map(dataset => <button key={dataset.id} className="dataset-row" onClick={() => navigate('data')}><DatabaseOutlined /><span>{dataset.name}</span><ArrowRightOutlined /></button>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可访问的数据集" />}
    </section>}</div>
  </div>;
}
