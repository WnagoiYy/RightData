import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, '..', '..');
const backendSessionPath = path.join(workspace, 'test', 'runtime', 'client-integration-session.json');
const nativeSessionPath = path.join(workspace, 'test', 'runtime', 'client-native-session.json');
const resultPath = path.join(workspace, 'test', 'results', 'client-native-events.json');
const backend = JSON.parse((await readFile(backendSessionPath, 'utf8')).replace(/^\uFEFF/, ''));
const nativeSession = JSON.parse((await readFile(nativeSessionPath, 'utf8')).replace(/^\uFEFF/, ''));
const secrets = [backend.password];
const checks = [];

function redact(value) {
  let output = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, '[redacted]');
  }
  return output;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function until(check, timeout = 30_000, interval = 250) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw lastError || new Error('condition did not become ready');
}

async function connectCdp(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => {
    if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
    return response.json();
  });
  const target = targets.find(item => item.type === 'page' && item.url?.includes(':1420'))
    || targets.find(item => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('Tauri WebView CDP target was not found');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the Tauri CDP target')), { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || 'CDP command failed'));
    else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('Tauri CDP connection closed'));
    pending.clear();
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Tauri CDP connection is not open')); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'CDP evaluation failed');
    }
    return response.result?.value;
  };
  return {
    evaluate,
    close() {
      socket.close();
    },
  };
}

let cdp = await connectCdp(nativeSession.port || 9225);
const invoke = async (command, request) => {
  const payload = JSON.stringify({ command, request });
  const result = await cdp.evaluate(`(async payload => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(
        payload.command,
        payload.request === undefined ? undefined : { request: payload.request },
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: {
        code: error?.code,
        status: error?.status,
        message: error?.message || String(error),
      } };
    }
  })(${payload})`);
  if (!result?.ok) {
    const error = new Error(`${command}: ${result?.error?.message || 'native command failed'}`);
    error.code = result?.error?.code;
    error.status = result?.error?.status;
    throw error;
  }
  return result.value;
};

async function api(method, pathname, body, idempotencyKey) {
  const response = await invoke('api_request', {
    method,
    path: pathname,
    ...(body === undefined ? {} : { body }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  if (response.status >= 400 || response.data?.code !== 'ok') {
    throw new Error(`${method} ${pathname}: ${response.data?.code || response.status} ${response.data?.message || 'request failed'}`);
  }
  return response.data.data;
}

async function waitForJob(jobId) {
  return until(async () => {
    const job = await api('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    return ['succeeded', 'failed', 'canceled', 'expired'].includes(job.state) ? job : false;
  }, 60_000);
}

let databaseId;
let loggedIn = false;
let serviceWasEnabled;
let servicePaused = false;
try {
  await until(() => cdp.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)'), 20_000);
  const initialService = await invoke('network_service_get_state');
  serviceWasEnabled = initialService.enabled;
  if (!initialService.enabled) await invoke('network_service_set_enabled', { enabled: true });

  await invoke('transport_configure', {
    serverUrl: backend.address,
    discoveryUrl: null,
    allowPublicRelay: false,
    rebindInstance: true,
  });
  const login = await invoke('auth_login', {
    username: backend.username,
    password: backend.password,
    remember: false,
  });
  loggedIn = true;
  const actorId = String(login.user?.id || '');
  assert.ok(actorId, 'native login did not return a user id');
  const transport = await invoke('transport_get_state');
  const instanceId = transport.connection?.instanceId || transport.settings?.boundInstanceId;
  assert.ok(instanceId, 'native transport did not bind a service instance');
  checks.push('native session authenticated through the Tauri transport');
  await until(async () => (await invoke('export_event_status')).pending === 0, 70_000, 500);

  const run = randomUUID().slice(0, 8);
  const databasePassword = `NativeEvents-${randomUUID()}`;
  secrets.push(databasePassword);
  const database = await api('POST', '/api/v1/data-files', {
    name: `native-events-${run}.duckdb`,
    password: databasePassword,
  });
  databaseId = database.id;
  const table = `event_rows_${run}`;
  await api(
    'POST',
    `/api/v1/datasets/${encodeURIComponent(databaseId)}/schema:mutate`,
    {
      action: 'create_table',
      table,
      fields: [
        { name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true },
        { name: 'label', dataType: 'VARCHAR', nullable: false },
      ],
    },
    `native-events-schema-${randomUUID()}`,
  );
  await api(
    'POST',
    `/api/v1/datasets/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(table)}/records:mutate`,
    { operations: [{ action: 'insert', values: { id: '9007199254740993', label: '原生事件补报' } }] },
    `native-events-row-${randomUUID()}`,
  );
  const submitted = await api(
    'POST',
    '/api/v1/export-jobs',
    { datasetId: databaseId, table, fields: ['id', 'label'], orderBy: [{ field: 'id', direction: 'ASC' }] },
    `native-events-export-${randomUUID()}`,
  );
  const exportJob = await waitForJob(submitted.jobId);
  assert.equal(exportJob.state, 'succeeded', exportJob.error);
  assert.equal(exportJob.clientReport?.outcome, 'unknown');
  checks.push('real export job completed before client file-generation reporting');

  const statusBefore = await invoke('export_event_status');
  const paused = await invoke('network_service_set_enabled', { enabled: false });
  assert.equal(paused.enabled, false);
  servicePaused = true;
  await invoke('export_event_enqueue', { jobId: submitted.jobId, outcome: 'success' });
  const queuedStatus = await until(async () => {
    const status = await invoke('export_event_status');
    return status.pending === statusBefore.pending + 1 ? status : false;
  }, 10_000);
  assert.equal(queuedStatus.rejected, statusBefore.rejected);

  const queuePath = path.join(nativeSession.runtime, 'state', 'client-events.json');
  const queueFile = JSON.parse((await readFile(queuePath, 'utf8')).replace(/^\uFEFF/, ''));
  const queuedEvents = queueFile.entries.filter(entry => entry.targetId === submitted.jobId);
  assert.equal(queuedEvents.length, 1);
  const queuedEvent = queuedEvents[0];
  assert.equal(queuedEvent.instanceId, instanceId);
  assert.equal(String(queuedEvent.userId), actorId);
  assert.equal(queuedEvent.category, 'client_export');
  assert.equal(queuedEvent.action, 'file_generation');
  assert.equal(queuedEvent.outcome, 'success');
  assert.equal(queuedEvent.rejection ?? null, null);
  assert.match(queuedEvent.eventId, /^[0-9a-f-]{36}$/i);
  checks.push('offline event persisted with native instance and user ownership');

  cdp.close();
  try {
    execFileSync('pwsh', ['-NoProfile', '-File', path.join(testDirectory, 'restart-native-client.ps1')], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    const restartedSession = JSON.parse((await readFile(nativeSessionPath, 'utf8')).replace(/^\uFEFF/, ''));
    assert.notEqual(restartedSession.pid, nativeSession.pid, 'native client process was not replaced');
  } finally {
    cdp = await until(() => connectCdp(nativeSession.port || 9225), 30_000);
  }
  await until(() => cdp.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)'), 20_000);
  const restartedService = await invoke('network_service_get_state');
  assert.equal(restartedService.enabled, false, 'restarting the UI must not undo explicit network pause');
  const restartedQueue = await invoke('export_event_status');
  assert.equal(restartedQueue.pending, queuedStatus.pending);
  checks.push('UI process restart preserves the pending event and the independent service pause');

  const resumed = await invoke('network_service_set_enabled', { enabled: true });
  assert.equal(resumed.enabled, true);
  servicePaused = false;
  await until(async () => {
    const status = await invoke('network_service_get_state');
    return status.ready ? status : false;
  }, 30_000);
  await invoke('transport_probe');
  await invoke('auth_login', { username: backend.username, password: backend.password, remember: false });
  await until(async () => {
    const status = await invoke('export_event_status');
    return status.pending === statusBefore.pending ? status : false;
  }, 70_000, 500);

  const events = await api(
    'GET',
    `/api/v1/client-events?targetId=${encodeURIComponent(submitted.jobId)}&limit=10`,
  );
  const matching = events.items.filter(event => event.eventId === queuedEvent.eventId);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].actorId, actorId);
  assert.equal(matching[0].instanceId, instanceId);
  assert.equal(matching[0].targetId, submitted.jobId);
  assert.equal(matching[0].outcome, 'success');
  checks.push('service recovery flushed one owned event and acknowledged the queue entry');

  const jobWithReport = await api('GET', `/api/v1/jobs/${encodeURIComponent(submitted.jobId)}`);
  assert.equal(jobWithReport.clientReport?.eventId, queuedEvent.eventId);
  assert.equal(jobWithReport.clientReport?.stage, 'file_generation');
  assert.equal(jobWithReport.clientReport?.outcome, 'success');

  const duplicateReceipt = await api(
    'POST',
    '/api/v1/client-events',
    {
      eventId: queuedEvent.eventId,
      instanceId: queuedEvent.instanceId,
      occurredAt: queuedEvent.occurredAt,
      category: queuedEvent.category,
      action: queuedEvent.action,
      targetId: queuedEvent.targetId,
      outcome: queuedEvent.outcome,
    },
    queuedEvent.eventId,
  );
  assert.equal(duplicateReceipt.eventId, queuedEvent.eventId);
  const afterDuplicate = await api(
    'GET',
    `/api/v1/client-events?targetId=${encodeURIComponent(submitted.jobId)}&limit=10`,
  );
  assert.equal(afterDuplicate.items.filter(event => event.eventId === queuedEvent.eventId).length, 1);
  checks.push('replaying the same event payload is idempotent');

  await writeFile(resultPath, `${JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const safeError = redact(error);
  await writeFile(resultPath, `${JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: safeError }, null, 2)}\n`);
  throw new Error(safeError);
} finally {
  if (servicePaused) {
    await invoke('network_service_set_enabled', { enabled: true }).catch(() => {});
  }
  if (databaseId) {
    await api('DELETE', `/api/v1/data-files/${encodeURIComponent(databaseId)}`).catch(() => {});
  }
  if (loggedIn) await invoke('auth_logout').catch(() => {});
  if (serviceWasEnabled === false) {
    await invoke('network_service_set_enabled', { enabled: false }).catch(() => {});
  }
  cdp.close();
}
