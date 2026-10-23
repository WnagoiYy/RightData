import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpsServer, request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createDiscoveryServer } from '../../deploy/discovery/server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = randomUUID();
const directory = fileURLToPath(new URL(`../runtime/client-network-${runId}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const backend = JSON.parse((await readFile(new URL('../runtime/client-integration-session.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const binary = process.env.RIGHTDATA_NETWORK_BINARY || `${root}/test/build/network-service-check/x86_64-pc-windows-msvc/debug/rightdata-network-service.exe`;
const certPath = `${directory}/localhost.pem`;
const keyPath = `${directory}/localhost.key`;
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:FALSE'], { stdio: 'ignore', windowsHide: true });
const certificate = await readFile(certPath);
const tlsBackend = createHttpsServer({ key: await readFile(keyPath), cert: certificate }, (req, res) => {
  const forward = httpRequest(new URL(req.url, backend.address), { method: req.method, headers: { ...req.headers, host: new URL(backend.address).host } }, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
  });
  forward.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(forward);
});
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const tlsPort = await listen(tlsBackend);
const discovery = createDiscoveryServer({ rateLimitMax: 1000 });
const discoveryPort = await listen(discovery);
const discoveryUrl = `http://127.0.0.1:${discoveryPort}`;
const reserved = createTcpServer();
const closedPort = await listen(reserved);
await new Promise(resolve => reserved.close(resolve));
const processes = [];
const pipes = [];
const checks = [];
let restoredDirect;
const directSockets = new Set();

function pipeCall(pipe, op, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(pipe);
    const id = randomUUID();
    let bytes = Buffer.alloc(0);
    socket.setTimeout(15000, () => socket.destroy(new Error('control pipe timeout')));
    socket.once('error', reject);
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ v: 1, id, op, ...extra }));
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); socket.write(Buffer.concat([prefix, body]));
    });
    socket.on('data', part => {
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (length > 65536) { socket.destroy(new Error('oversize control frame')); return; }
      if (bytes.length < length + 4) return;
      const response = JSON.parse(bytes.subarray(4, length + 4)); socket.end();
      if (response.id !== id || response.v !== 1) { reject(new Error('invalid control response')); return; }
      if (!response.ok) { reject(new Error(response.error?.message || 'control failed')); return; }
      resolve(response.data);
    });
  });
}
async function until(check, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw last || new Error('condition did not become ready');
}
async function startNode(name, serverUrl, instanceId) {
  const folder = `${directory}/${name}`; await mkdir(folder, { recursive: true });
  const pipe = `\\\\.\\pipe\\rightdata-test-${name}-${runId}`;
  pipes.push(pipe);
  const config = { serverUrl, discoveryUrl, boundInstanceId: instanceId, allowPublicRelay: false, enabled: true };
  await writeFile(`${folder}/network.json`, JSON.stringify(config));
  const localBinary = `${folder}/rightdata-network-service.exe`; await copyFile(binary, localBinary);
  const child = spawn(localBinary, ['--data-dir', folder], {
    env: { ...process.env, RIGHTDATA_NETWORK_PIPE: pipe, RIGHTDATA_TEST_CA_PEM: certPath },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(createWriteStream(`${folder}/stdout.log`)); child.stderr.pipe(createWriteStream(`${folder}/stderr.log`));
  processes.push(child);
  return { pipe, process: child, status: await until(() => pipeCall(pipe, 'status')) };
}

class TunnelAgent extends HttpsAgent {
  constructor(status, servername = 'localhost') { super({ keepAlive: false }); this.status = status; this.servername = servername; }
  createConnection(options, callback) {
    const proxy = new URL(this.status.proxyUrl);
    const connect = httpRequest({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${options.host}:${options.port}`, headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`rightdata:${this.status.proxyToken}`).toString('base64')}` } });
    let called = false;
    const done = (error, socket) => { if (!called) { called = true; callback(error, socket); } };
    connect.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); done(new Error(`proxy status ${response.statusCode}`)); return; }
      if (head.length) socket.unshift(head);
      const secure = tlsConnect({ socket, servername: this.servername, ca: certificate, rejectUnauthorized: true }, () => done(null, secure));
      secure.on('error', error => done(error));
    });
    connect.on('error', error => done(error)); connect.setTimeout(20000, () => connect.destroy(new Error('proxy timeout'))); connect.end();
  }
}

function request(status, logicalUrl, path, { method = 'GET', body, token, servername } = {}) {
  const agent = new TunnelAgent(status, servername);
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpsRequest(new URL(path, logicalUrl), { method, agent, headers: { ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), Connection: 'close' } }, response => {
      const chunks = []; response.on('data', part => chunks.push(part));
      response.on('end', () => { agent.destroy(); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
    });
    request.on('error', error => { agent.destroy(); reject(error); });
    request.setTimeout(25000, () => request.destroy(new Error('business request timeout')));
    if (encoded) request.write(encoded); request.end();
  });
}

try {
  const internalUrl = `https://localhost:${tlsPort}`;
  const localNode = await startNode('internal', internalUrl);
  const internal = await until(async () => { const status = await pipeCall(localNode.pipe, 'status'); if (!status.ready && status.lastError) throw new Error(status.lastError); return status.ready && status.boundInstanceId ? status : false; });
  const instance = internal.boundInstanceId;
  await until(async () => { const nodes = await fetch(`${discoveryUrl}/v1/instances/${instance}/nodes`).then(response => response.json()); return nodes.nodes?.some(node => node.endpointId === internal.deviceId); });
  checks.push('internal node automatically registers without business login');
  const externalUrl = `https://localhost:${closedPort}`;
  const externalNode = await startNode('external', externalUrl, instance);
  const status = externalNode.status;
  const probe = await request(status, externalUrl, '/api/probe');
  assert.equal(probe.status, 200); assert.equal(probe.body.data.instanceId, instance);
  assert.equal((await pipeCall(externalNode.pipe, 'status')).mode, 'peer');
  checks.push('unreachable direct endpoint falls back to iroh peer with end-to-end verified TLS');
  await assert.rejects(request(status, externalUrl, '/api/probe', { servername: 'wrong-host.invalid' }));
  checks.push('TLS hostname mismatch is rejected through the peer tunnel');
  const login = await request(status, externalUrl, '/api/v1/auth/login', { method: 'POST', body: { username: backend.username, password: backend.password } });
  assert.equal(login.status, 200);
  const token = login.body.data.accessToken;
  assert.ok(token);
  const datasets = await request(status, externalUrl, '/api/v1/datasets', { token });
  assert.equal(datasets.status, 200); assert.equal(datasets.body.code, 'ok');
  checks.push('login and authenticated business query travel through the peer without node business login');
  const after = await pipeCall(externalNode.pipe, 'status'); assert.equal(after.allowPublicRelay, false);
  const published = await fetch(`${discoveryUrl}/v1/instances/${instance}/nodes`).then(response => response.json());
  assert.ok(published.nodes.every(node => !node.relayUrl));
  checks.push('public business relay is disabled and registration contains no relay URL');
  await pipeCall(externalNode.pipe, 'stop');
  await assert.rejects(request(status, externalUrl, '/api/probe'));
  assert.equal((await pipeCall(externalNode.pipe, 'status')).enabled, false);
  checks.push('explicit pause blocks business traffic and status probes do not restart it');
  const resumed = await pipeCall(externalNode.pipe, 'start');
  assert.equal(resumed.deviceId, status.deviceId);
  assert.equal((await request(resumed, externalUrl, '/api/probe')).status, 200);
  const logs = await pipeCall(externalNode.pipe, 'logs');
  assert.ok(logs.items.length > 0);
  assert.ok(!JSON.stringify(logs).includes(token)); assert.ok(!JSON.stringify(logs).includes(backend.password));
  checks.push('restart retains device identity and transport logs omit business credentials');

  const backupNode = await startNode('internal-backup', internalUrl);
  await until(async () => {
    const nodes = await fetch(`${discoveryUrl}/v1/instances/${instance}/nodes`).then(response => response.json());
    return nodes.nodes?.length >= 2;
  });
  await request(resumed, externalUrl, '/api/probe');
  const selectedPeer = (await pipeCall(externalNode.pipe, 'status')).peerId;
  const selectedNode = [localNode, backupNode].find(node => node.status.deviceId === selectedPeer);
  assert.ok(selectedNode, 'selected peer must belong to one of the two internal test nodes');
  selectedNode.process.kill();
  await until(() => selectedNode.process.exitCode !== null || selectedNode.process.signalCode !== null);
  const recovered = await request(resumed, externalUrl, '/api/v1/datasets', { token });
  assert.equal(recovered.status, 200);
  const recoveredStatus = await pipeCall(externalNode.pipe, 'status');
  assert.equal(recoveredStatus.mode, 'peer');
  assert.notEqual(recoveredStatus.peerId, selectedPeer);
  checks.push('a failed selected peer is replaced by another internal node while retaining the business session');

  restoredDirect = createTcpServer(socket => {
    const upstream = netConnect({ host: '127.0.0.1', port: tlsPort });
    directSockets.add(socket); directSockets.add(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => { directSockets.delete(socket); upstream.destroy(); });
    upstream.on('close', () => { directSockets.delete(upstream); socket.destroy(); });
    socket.pipe(upstream); upstream.pipe(socket);
  });
  await new Promise((resolve, reject) => { restoredDirect.once('error', reject); restoredDirect.listen(closedPort, '127.0.0.1', resolve); });
  await until(async () => {
    const result = await request(resumed, externalUrl, '/api/v1/datasets', { token });
    assert.equal(result.status, 200);
    return (await pipeCall(externalNode.pipe, 'status')).mode === 'direct';
  }, 65_000);
  checks.push('restoring the same logical TLS endpoint switches subsequent requests back to direct without logging in again');
  await request(resumed, externalUrl, '/api/v1/auth/logout', { method: 'POST', token, body: {} });
  await writeFile(new URL('../results/client-network-integration.json', import.meta.url), JSON.stringify({ passed: true, time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  await writeFile(new URL('../results/client-network-integration.json', import.meta.url), JSON.stringify({ passed: false, time: new Date().toISOString(), checks, error: String(error) }, null, 2));
  throw error;
} finally {
  await Promise.all(pipes.map(pipe => pipeCall(pipe, 'stop').catch(() => {})));
  for (const child of processes) child.kill();
  for (const socket of directSockets) socket.destroy();
  if (restoredDirect) await new Promise(resolve => restoredDirect.close(resolve));
  discovery.closeAllConnections(); await new Promise(resolve => discovery.close(resolve));
  tlsBackend.closeAllConnections(); await new Promise(resolve => tlsBackend.close(resolve));
}
