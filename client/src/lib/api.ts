import { invoke, isTauri } from '@tauri-apps/api/core';

export type User = { id: string; username: string; permissions: string[]; disabled: boolean; authzRevision?: number | string };
export type ConnectionSettings = { serverUrl: string; discoveryUrl?: string; allowPublicRelay: boolean };
export type TransportState = {
  settings: ConnectionSettings;
  connection: { mode: 'disconnected' | 'direct' | 'peer'; instanceId?: string; apiVersion?: string; ready: boolean; lastError?: string };
  session: { authenticated: boolean; user?: User; remember: boolean };
};
export type RequestOptions = { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal };
export interface Api {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  rawRequest(path: string, options?: RequestOptions): Promise<NativeResponse>;
  upload<T>(path: string, file: File, options?: { fields?: Record<string, string>; method?: string }): Promise<T>;
  download(path: string, name: string): Promise<void>;
  readDownload(path: string, maxBytes?: number): Promise<Uint8Array>;
  saveFile(name: string, bytes: Uint8Array): Promise<void>;
  recordExportEvent(jobId: string, outcome: 'success' | 'failed' | 'canceled'): Promise<void>;
}
type Envelope<T> = { code: string; message: string; data: T; requestId?: string };
export type NativeResponse = { status: number; data: unknown; requestId?: string; headers?: Record<string, string> };

export class ApiError extends Error {
  code: string;
  status?: number;
  requestId?: string;
  constructor(message: string, code = 'unknown', status?: number, requestId?: string) {
    super(message); this.name = 'ApiError'; this.code = code; this.status = status; this.requestId = requestId;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : '操作失败，请重试';
}

export async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new ApiError('请在桌面客户端中连接服务', 'desktop_required');
  try { return await invoke<T>(command, args); }
  catch (cause) {
    const detail = typeof cause === 'object' && cause ? cause as { message?: string; code?: string; status?: number; requestId?: string } : {};
    const error = new ApiError(detail.message || errorMessage(cause), detail.code, detail.status, detail.requestId);
    if (command !== 'auth_login' && (error.status === 401 || error.code === 'unauthenticated')) window.dispatchEvent(new Event('rightdata:session-expired'));
    throw error;
  }
}

export function unwrap<T>(response: NativeResponse): T {
  const value = response.data as Partial<Envelope<T>> | null;
  if (response.status >= 400 || (value && typeof value === 'object' && typeof value.code === 'string' && value.code !== 'ok')) {
    const error = new ApiError(value?.message || '请求失败', value?.code, response.status, response.requestId || value?.requestId);
    if (error.status === 401) window.dispatchEvent(new Event('rightdata:session-expired'));
    throw error;
  }
  return (value && typeof value === 'object' && value.code === 'ok' ? value.data : response.data) as T;
}

// Every production request crosses the native bridge. The browser preview never holds business credentials.
export const api: Api = {
  async recordExportEvent(jobId, outcome) {
    await native('export_event_enqueue', { request: { jobId, outcome } });
  },
  async rawRequest(path: string, options: RequestOptions = {}) {
    if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const response = await native<NativeResponse>('api_request', { request: {
      method: options.method || 'GET', path, body: options.body,
      idempotencyKey: options.idempotencyKey,
    } });
    if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    return response;
  },
  async request<T>(path: string, options: RequestOptions = {}) {
    return unwrap<T>(await api.rawRequest(path, options));
  },
  async upload<T>(path: string, file: File, options?: { fields?: Record<string, string>; method?: string }) {
    if (file.size > 50 * 1024 * 1024) throw new ApiError('此上传入口最多支持 50 MB 文件', 'upload_too_large');
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const fields = { ...(path.split('?')[0] === '/api/v1/uploads' ? { purpose: 'import' } : {}), ...options?.fields };
    const response = await native<NativeResponse>('api_upload', { request: { path, method: options?.method || 'POST', fileName: file.name, bytes, fields, mediaType: file.type || 'application/octet-stream' } });
    return unwrap<T>(response);
  },
  async download(path: string, name: string) {
    const result = await native<{ saved?: boolean }>('api_download', { request: { path, suggestedName: name } });
    if (result.saved === false) throw new ApiError('已取消保存', 'canceled');
  },
  async readDownload(path: string, maxBytes = 64 * 1024 * 1024) {
    const value = await native<ArrayBuffer | number[]>('api_download_read', { request: { path, maxBytes } });
    return new Uint8Array(value);
  },
  async saveFile(name: string, bytes: Uint8Array) { await saveLocalFile(name, bytes); },
};

export function hasPermission(permissions: string[], permission: string) {
  return permissions.includes('*') || permissions.includes(permission);
}

export async function saveLocalFile(name: string, bytes: Uint8Array) {
  const result = await native<{ saved: boolean; path?: string }>('desktop_save_file', { request: { suggestedName: name, bytes: Array.from(bytes) } });
  if (!result.saved) throw new ApiError('已取消保存', 'canceled');
  return result;
}
