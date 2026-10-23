import http from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const DISCOVERY_PROTOCOL = 'rightdata/discovery/1';
const NODE_PROTOCOL = 'rightdata/relay/1';
const PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('canonical JSON supports JSON values only');
}

export function signatureMessage(method, path, expiresAt, payload) {
  return Buffer.from(`${method.toUpperCase()}\n${path}\n${expiresAt}\n${canonicalJson(payload)}`, 'utf8');
}

function publicKeyFromEndpointId(endpointId) {
  return createPublicKey({ key: Buffer.concat([PUBLIC_KEY_PREFIX, Buffer.from(endpointId, 'hex')]), format: 'der', type: 'spki' });
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_body', '请求体必须是 JSON 对象');
}

function assertExactKeys(body, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(body, key)) throw new HttpError(400, 'missing_field', `缺少字段 ${key}`);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new HttpError(400, 'unknown_field', `不支持字段 ${key}`);
}

function validateEndpointId(endpointId) {
  if (typeof endpointId !== 'string' || !/^[0-9a-f]{64}$/.test(endpointId)) throw new HttpError(400, 'invalid_endpoint_id', 'endpointId 必须是 Ed25519 公钥的小写十六进制');
}

function validateExpiry(expiresAt, now) {
  if (!Number.isSafeInteger(expiresAt)) throw new HttpError(400, 'invalid_expiry', 'expiresAt 必须是 Unix 毫秒整数');
  if (expiresAt <= now) throw new HttpError(401, 'expired_signature', '签名已过期');
  if (expiresAt > now + 90_000) throw new HttpError(400, 'expiry_too_far', 'expiresAt 超出允许时间窗口');
}

function validateSignature(signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new HttpError(400, 'invalid_signature', 'signature 必须是 64 字节 Ed25519 签名的标准 Base64');
  return Buffer.from(signature, 'base64');
}

function validateDirectAddress(value) {
  if (typeof value !== 'string' || value.length > 96) return false;
  let host;
  let portText;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 2 || value[end + 1] !== ':') return false;
    host = value.slice(1, end);
    portText = value.slice(end + 2);
    if (isIP(host) !== 6) return false;
  } else {
    const separator = value.lastIndexOf(':');
    if (separator <= 0) return false;
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
    if (isIP(host) !== 4) return false;
  }
  if (!/^\d{1,5}$/.test(portText)) return false;
  const port = Number(portText);
  return port >= 1 && port <= 65_535;
}

function validateDirectAddresses(value) {
  if (!Array.isArray(value) || value.length > 16 || value.some(address => !validateDirectAddress(address))) throw new HttpError(400, 'invalid_direct_addresses', 'directAddresses 仅允许数值 IP socket 地址');
  const normalized = [...new Set(value)].sort(compareCodePoints);
  if (canonicalJson(normalized) !== canonicalJson(value)) throw new HttpError(400, 'direct_addresses_order', 'directAddresses 必须排序且去重');
  return normalized;
}

function validateRelayUrl(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 512) throw new HttpError(400, 'invalid_relay_url', 'relayUrl 无效');
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'invalid_relay_url', 'relayUrl 无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new HttpError(400, 'invalid_relay_url', 'relayUrl 必须使用无凭据的 HTTPS URL');
  return url.toString();
}

function parseRoute(url) {
  if (url.search) throw new HttpError(400, 'query_not_allowed', '此接口不接受查询参数');
  const parts = url.pathname.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { throw new HttpError(400, 'invalid_path', '路径编码无效'); }
  });
  if (parts[0] !== 'v1' || parts[1] !== 'instances' || parts[3] !== 'nodes' || (parts.length !== 4 && parts.length !== 5)) return undefined;
  const instanceId = parts[2];
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId)) throw new HttpError(400, 'invalid_instance_id', 'instanceId 无效');
  const endpointId = parts[4];
  if (endpointId !== undefined) validateEndpointId(endpointId);
  const path = `/v1/instances/${instanceId}/nodes${endpointId ? `/${endpointId}` : ''}`;
  return { instanceId, endpointId, path };
}

async function readJson(request, maxBodyBytes) {
  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength > maxBodyBytes) throw new HttpError(413, 'payload_too_large', '请求体过大');
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) { tooLarge = true; continue; }
    chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, 'payload_too_large', '请求体过大');
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json_required', '请求体必须使用 application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', '请求体不是有效 JSON'); }
}

function send(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(encoded);
}

function requestIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return request.socket.remoteAddress || 'unknown';
}

export function createDiscoveryServer(options = {}) {
  const now = options.now || Date.now;
  const maxBodyBytes = options.maxBodyBytes || 16 * 1024;
  const rateLimitMax = options.rateLimitMax || 120;
  const trustProxy = options.trustProxy === true;
  const nodes = new Map();
  const replay = new Map();
  const rates = new Map();
  let totalNodes = 0;
  let lastRatePrune = 0;

  function prune(time) {
    for (const [signature, expiry] of replay) if (expiry <= time) replay.delete(signature);
    for (const [instanceId, instance] of nodes) {
      for (const [endpointId, node] of instance) {
        if (node.expiresAt <= time) { instance.delete(endpointId); totalNodes -= 1; }
      }
      if (instance.size === 0) nodes.delete(instanceId);
    }
  }

  function checkRate(request, time) {
    if (time < lastRatePrune || time - lastRatePrune >= 60_000) {
      for (const [ip, rate] of rates) if (time < rate.startedAt || time - rate.startedAt >= 60_000) rates.delete(ip);
      lastRatePrune = time;
    }
    const ip = requestIp(request, trustProxy);
    const current = rates.get(ip);
    if (!current || time - current.startedAt >= 60_000) { rates.set(ip, { startedAt: time, count: 1 }); return; }
    current.count += 1;
    if (current.count > rateLimitMax) throw new HttpError(429, 'rate_limited', '请求过于频繁');
  }

  function verifySignedRequest(method, path, endpointId, body, payload, time) {
    if (body.protocol !== NODE_PROTOCOL) throw new HttpError(400, 'invalid_protocol', 'protocol 不受支持');
    if (body.endpointId !== endpointId) throw new HttpError(400, 'endpoint_mismatch', 'endpointId 与路径不一致');
    validateExpiry(body.expiresAt, time);
    const signatureBytes = validateSignature(body.signature);
    if (replay.has(body.signature)) throw new HttpError(409, 'replayed_signature', '签名已使用');
    let valid = false;
    try { valid = verify(null, signatureMessage(method, path, body.expiresAt, payload), publicKeyFromEndpointId(endpointId), signatureBytes); } catch { valid = false; }
    if (!valid) throw new HttpError(401, 'signature_invalid', '签名校验失败');
    replay.set(body.signature, body.expiresAt);
  }

  const server = http.createServer(async (request, response) => {
    const time = now();
    try {
      checkRate(request, time);
      prune(time);
      const url = new URL(request.url || '/', 'http://discovery.local');
      if (request.method === 'GET' && url.pathname === '/healthz' && !url.search) { send(response, 200, { status: 'ok' }); return; }
      const route = parseRoute(url);
      if (!route) throw new HttpError(404, 'not_found', '接口不存在');

      if (request.method === 'GET' && !route.endpointId) {
        const instance = nodes.get(route.instanceId);
        const result = [...(instance?.values() || [])].sort((a, b) => compareCodePoints(a.endpointId, b.endpointId)).map(node => ({
          protocol: node.protocol,
          endpointId: node.endpointId,
          directAddresses: [...node.directAddresses],
          ...(node.relayUrl ? { relayUrl: node.relayUrl } : {}),
          expiresAt: node.expiresAt,
        }));
        send(response, 200, { protocol: DISCOVERY_PROTOCOL, instanceId: route.instanceId, generatedAt: time, nodes: result });
        return;
      }

      if (request.method === 'PUT' && route.endpointId) {
        const body = await readJson(request, maxBodyBytes);
        assertObject(body);
        assertExactKeys(body, ['protocol', 'endpointId', 'directAddresses', 'expiresAt', 'signature'], ['relayUrl']);
        const directAddresses = validateDirectAddresses(body.directAddresses);
        const relayUrl = validateRelayUrl(body.relayUrl);
        const payload = { protocol: body.protocol, endpointId: body.endpointId, directAddresses, ...(body.relayUrl ? { relayUrl: body.relayUrl } : {}), expiresAt: body.expiresAt };
        verifySignedRequest('PUT', route.path, route.endpointId, body, payload, time);
        let instance = nodes.get(route.instanceId);
        const isNewEndpoint = !instance?.has(route.endpointId);
        if (isNewEndpoint && instance?.size >= 256) throw new HttpError(429, 'instance_full', '实例节点数量已达上限');
        if (isNewEndpoint && totalNodes >= 10_000) throw new HttpError(503, 'capacity_reached', '服务容量已达上限');
        if (!instance) { instance = new Map(); nodes.set(route.instanceId, instance); }
        if (isNewEndpoint) totalNodes += 1;
        const effectiveExpiry = Math.min(body.expiresAt, time + 60_000);
        instance.set(route.endpointId, { protocol: NODE_PROTOCOL, endpointId: route.endpointId, directAddresses, ...(relayUrl ? { relayUrl } : {}), expiresAt: effectiveExpiry });
        send(response, 200, { protocol: DISCOVERY_PROTOCOL, registered: true, expiresAt: effectiveExpiry });
        return;
      }

      if (request.method === 'DELETE' && route.endpointId) {
        const body = await readJson(request, maxBodyBytes);
        assertObject(body);
        assertExactKeys(body, ['protocol', 'endpointId', 'expiresAt', 'signature']);
        const payload = { protocol: body.protocol, endpointId: body.endpointId, expiresAt: body.expiresAt };
        verifySignedRequest('DELETE', route.path, route.endpointId, body, payload, time);
        const instance = nodes.get(route.instanceId);
        const removed = instance?.delete(route.endpointId) || false;
        if (removed) totalNodes -= 1;
        if (instance?.size === 0) nodes.delete(route.instanceId);
        send(response, 200, { protocol: DISCOVERY_PROTOCOL, removed });
        return;
      }

      throw new HttpError(405, 'method_not_allowed', '请求方法不受支持');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal_error';
      const message = error instanceof HttpError ? error.message : '服务内部错误';
      if (!response.headersSent) send(response, status, { code, message });
      else response.end();
    }
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const host = process.env.DISCOVERY_HOST || '127.0.0.1';
  const port = Number(process.env.DISCOVERY_PORT || 8090);
  const server = createDiscoveryServer({
    maxBodyBytes: Number(process.env.DISCOVERY_MAX_BODY_BYTES || 16 * 1024),
    rateLimitMax: Number(process.env.DISCOVERY_RATE_LIMIT_PER_MINUTE || 120),
    trustProxy: process.env.DISCOVERY_TRUST_PROXY === '1',
  });
  server.listen(port, host, () => process.stdout.write(`RightData discovery listening on ${host}:${port}\n`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
