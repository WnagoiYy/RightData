import { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { listen } from '@tauri-apps/api/event';
import { native, type Api } from '../../lib/api';
import { Failure } from '../../components/Feedback';
import { ResourceRenderer } from '../config/ResourceRenderer';
import type { QueryResult, SharedConfig } from '../config/types';

export function PreviewWindow({ api }: { api: Api }) {
  const [state, setState] = useState<{ resource: SharedConfig; params: Record<string, unknown> }>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    const load = () => { setState(undefined); setError(undefined); void native<{ resource: SharedConfig; params: Record<string, unknown> }>('preview_get_state').then(value => { if (active) setState(value); }).catch(cause => { if (active) setError(cause); }); };
    load();
    void listen('rightdata:preview-updated', load).then(unlisten => { if (!active) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { active = false; stop?.(); };
  }, []);
  if (error) return <Failure error={error} />;
  if (!state) return <Spin />;
  return <ResourceRenderer preview resource={state.resource} params={state.params} onParamsChange={params => setState({ ...state, params })} execute={async (definitionId, params) => {
    const result = await api.request<{ data: QueryResult }>('/api/v1/resources/preview', { method: 'POST', body: { id: state.resource.id, kind: state.resource.kind, body: state.resource.body, definitionId, params } }); return result.data;
  }} />;
}
