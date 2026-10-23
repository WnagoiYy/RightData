import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, '..', '..');
const backendSessionPath = path.join(workspace, 'test', 'runtime', 'client-integration-session.json');
const nativeSessionPath = path.join(workspace, 'test', 'runtime', 'client-native-session.json');
const restartScript = path.join(testDirectory, 'restart-native-client.ps1');
const resultPath = path.join(workspace, 'test', 'results', 'client-native-exit.json');
const backend = JSON.parse((await readFile(backendSessionPath, 'utf8')).replace(/^\uFEFF/, ''));
const checks = [];
const secrets = [backend.password];

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

function redact(value) {
  let output = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, '[redacted]');
  }
  return output;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validateSession(session) {
  const runtime = path.resolve(session.runtime);
  const allowedPrefix = path.resolve(workspace, 'test', 'runtime', 'client-native-').toLowerCase();
  assert.ok(runtime.toLowerCase().startsWith(allowedPrefix), 'native runtime is outside the isolated test path');
  assert.equal(path.resolve(session.executable), path.join(runtime, 'client.exe'), 'unexpected native client executable');
  assert.equal(session.port, 9225, 'native test must use the isolated CDP port');
  assert.match(session.pipe, /^\\\\\.\\pipe\\rightdata-test-native-/i, 'unexpected native service pipe');
  assert.ok(Number.isInteger(session.pid) && session.pid > 0, 'invalid native client PID');
  assert.ok(Number.isInteger(session.servicePid) && session.servicePid > 0, 'invalid native service PID');
  return session;
}

async function readNativeSession() {
  return validateSession(JSON.parse((await readFile(nativeSessionPath, 'utf8')).replace(/^\uFEFF/, '')));
}

function pipeCall(pipe, op) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipe);
    const id = randomUUID();
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(10_000, () => finish(new Error('network service pipe timed out')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => {
      const body = Buffer.from(JSON.stringify({ v: 1, id, op }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(body.length);
      socket.write(Buffer.concat([prefix, body]));
    });
    socket.on('data', part => {
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (length > 65_536) {
        finish(new Error('network service returned an oversized frame'));
        return;
      }
      if (bytes.length < length + 4) return;
      const response = JSON.parse(bytes.subarray(4, length + 4));
      if (response.v !== 1 || response.id !== id) {
        finish(new Error('network service returned an invalid response'));
      } else if (!response.ok) {
        finish(new Error(response.error?.message || 'network service command failed'));
      } else {
        finish(undefined, response.data);
      }
    });
  });
}

async function connectCdp(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => {
    if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
    return response.json();
  });
  const target = targets.find(item => item.type === 'page' && !item.url?.includes('preview='))
    || targets.find(item => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('Tauri main WebView CDP target was not found');

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
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message || 'CDP command failed'));
    else callbacks.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const callbacks of pending.values()) callbacks.reject(new Error('Tauri CDP connection closed'));
    pending.clear();
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('Tauri CDP connection is not open'));
      return;
    }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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

function nativeInvoker(cdp) {
  return async (command, request) => {
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
    if (!result?.ok) throw new Error(`${command}: ${result?.error?.message || 'native command failed'}`);
    return result.value;
  };
}

async function requestAppExit(cdp) {
  try {
    await cdp.evaluate(`(() => {
      void window.__TAURI_INTERNALS__.invoke('app_exit').catch(() => {});
      return true;
    })()`);
  } catch {
    // The WebView can close before CDP sends the evaluation result.
  }
}

async function assertCdpStopped(port) {
  return until(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`);
      return false;
    } catch {
      return true;
    }
  }, 20_000);
}

function restartNativeClient() {
  execFileSync(
    'pwsh',
    ['-NoProfile', '-File', restartScript],
    { stdio: 'ignore', windowsHide: true, timeout: 30_000 },
  );
}

async function reconnectAfterRestart(previousPid, servicePid, deviceId) {
  restartNativeClient();
  const session = await readNativeSession();
  assert.notEqual(session.pid, previousPid, 'native client process was not replaced');
  assert.equal(session.servicePid, servicePid, 'restart changed the isolated service PID');
  assert.ok(processIsAlive(servicePid), 'isolated network service exited during UI restart');
  const status = await pipeCall(session.pipe, 'status');
  assert.equal(status.running, true, 'isolated network service pipe is not running');
  assert.equal(status.deviceId, deviceId, 'isolated network service device identity changed');
  const cdp = await until(() => connectCdp(session.port), 30_000);
  await until(() => cdp.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)'), 20_000);
  return { session, cdp, invoke: nativeInvoker(cdp) };
}

let cdp;
let completed = false;
let initialServiceEnabled;
try {
  const initialSession = await readNativeSession();
  assert.ok(processIsAlive(initialSession.pid), 'isolated native client is not running');
  assert.ok(processIsAlive(initialSession.servicePid), 'isolated network service is not running');
  const initialPipeStatus = await pipeCall(initialSession.pipe, 'status');
  assert.equal(initialPipeStatus.running, true);
  initialServiceEnabled = initialPipeStatus.enabled;
  const deviceId = initialPipeStatus.deviceId;
  assert.ok(deviceId, 'isolated network service did not expose a device identity');

  cdp = await until(() => connectCdp(initialSession.port), 20_000);
  await until(() => cdp.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)'), 20_000);
  let invoke = nativeInvoker(cdp);
  await invoke('auth_logout').catch(() => {});
  if (!initialPipeStatus.enabled) {
    const enabled = await invoke('network_service_set_enabled', { enabled: true });
    assert.equal(enabled.enabled, true);
  }
  await invoke('transport_configure', {
    serverUrl: backend.address,
    discoveryUrl: null,
    allowPublicRelay: false,
    rebindInstance: true,
  });
  const login = await invoke('auth_login', {
    username: backend.username,
    password: backend.password,
    remember: true,
  });
  assert.equal(login.authenticated, true);
  assert.equal(login.remember, true);
  const preview = await invoke('preview_open', {
    resourceId: `native-exit-${Date.now().toString(36)}`,
    title: '退出生命周期验证',
    draft: {
      id: 'unsaved-native-exit-draft',
      kind: 'h5',
      name: '退出生命周期验证',
      version: 0,
      body: {
        enabled: true,
        permissions: [],
        definitionIds: [],
        html: '<main><p>unsaved native exit draft</p></main>',
      },
    },
    params: { source: 'native-exit' },
  });
  assert.ok(preview.label.startsWith('preview-'));
  await until(async () => {
    const targets = await fetch(`http://127.0.0.1:${initialSession.port}/json/list`).then(response => response.json());
    return targets.some(target => target.type === 'page' && target.url?.includes('preview='));
  }, 20_000);
  checks.push('remembered native login opened an unsaved H5 draft in an independent preview');

  await requestAppExit(cdp);
  cdp.close();
  cdp = undefined;
  await until(() => !processIsAlive(initialSession.pid), 20_000);
  await assertCdpStopped(initialSession.port);
  assert.ok(processIsAlive(initialSession.servicePid), 'app_exit stopped the independent network service');
  const statusAfterFirstExit = await pipeCall(initialSession.pipe, 'status');
  assert.equal(statusAfterFirstExit.running, true);
  assert.equal(statusAfterFirstExit.deviceId, deviceId);
  checks.push('app_exit closed the main and preview WebViews while the same service PID and pipe stayed running');

  let restarted = await reconnectAfterRestart(initialSession.pid, initialSession.servicePid, deviceId);
  cdp = restarted.cdp;
  invoke = restarted.invoke;
  await until(() => cdp.evaluate(`document.body?.innerText?.includes('我的报表与看板')`), 30_000);
  const rememberedState = await invoke('transport_get_state');
  assert.equal(rememberedState.session.authenticated, true);
  assert.equal(rememberedState.session.remember, true);
  checks.push('restarted UI automatically restored the remembered user without restarting the service');

  const transientLogin = await invoke('auth_login', {
    username: backend.username,
    password: backend.password,
    remember: false,
  });
  assert.equal(transientLogin.authenticated, true);
  assert.equal(transientLogin.remember, false);
  const secondPid = restarted.session.pid;
  await requestAppExit(cdp);
  cdp.close();
  cdp = undefined;
  await until(() => !processIsAlive(secondPid), 20_000);
  await assertCdpStopped(restarted.session.port);
  assert.ok(processIsAlive(initialSession.servicePid), 'second app_exit stopped the independent network service');
  const statusAfterSecondExit = await pipeCall(initialSession.pipe, 'status');
  assert.equal(statusAfterSecondExit.deviceId, deviceId);

  restarted = await reconnectAfterRestart(secondPid, initialSession.servicePid, deviceId);
  cdp = restarted.cdp;
  invoke = restarted.invoke;
  const restored = await invoke('auth_restore');
  assert.equal(restored.authenticated, false);
  const finalState = await invoke('transport_get_state');
  assert.equal(finalState.session.authenticated, false);
  assert.equal(finalState.session.remember, false);
  await until(() => cdp.evaluate(`document.body?.innerText?.includes('用户登录')`), 20_000);
  checks.push('a non-remembered login was absent after the next UI restart and service identity stayed unchanged');

  if (initialServiceEnabled === false) {
    const restoredService = await invoke('network_service_set_enabled', { enabled: false });
    assert.equal(restoredService.enabled, false);
  }

  completed = true;
  await writeFile(resultPath, `${JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const safeError = redact(error);
  await writeFile(resultPath, `${JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: safeError }, null, 2)}\n`);
  throw new Error(safeError);
} finally {
  if (!completed && cdp) {
    const invoke = nativeInvoker(cdp);
    await invoke('auth_logout').catch(() => {});
    if (initialServiceEnabled === false) {
      await invoke('network_service_set_enabled', { enabled: false }).catch(() => {});
    }
  }
  cdp?.close();
}
