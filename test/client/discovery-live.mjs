import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { signatureMessage } from '../../deploy/discovery/server.mjs';

const base = new URL(process.argv[2] || 'https://39.106.128.14');
assert.equal(base.protocol, 'https:');
const instance = `verification-${randomUUID()}`;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const endpointId = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const collection = `/v1/instances/${instance}/nodes`;
const path = `${collection}/${endpointId}`;
function body(method, expiresAt, fields = {}) {
  const value = { protocol: 'rightdata/relay/1', endpointId, ...fields, expiresAt };
  return { ...value, signature: sign(null, signatureMessage(method, path, expiresAt, value), privateKey).toString('base64') };
}
async function request(route, method = 'GET', value) {
  const response = await fetch(new URL(route, base), {
    method, signal: AbortSignal.timeout(15000),
    headers: value ? { 'content-type': 'application/json' } : {},
    body: value ? JSON.stringify(value) : undefined,
  });
  return { status: response.status, body: await response.json() };
}
const started = performance.now();
const health = await request('/rightdata-discovery/healthz');
assert.equal(health.status, 200);
const registration = body('PUT', Date.now() + 30000, { directAddresses: ['127.0.0.1:4433'] });
try {
  assert.equal((await request(path, 'PUT', registration)).status, 200);
  const listed = await request(collection);
  assert.equal(listed.body.protocol, 'rightdata/discovery/1');
  assert.equal(listed.body.nodes[0].endpointId, endpointId);
  assert.equal('signature' in listed.body.nodes[0], false);
  assert.equal((await request(path, 'PUT', registration)).status, 409);
  const renewal = body('PUT', Date.now() + 45000, { directAddresses: ['127.0.0.1:4433'] });
  assert.equal((await request(path, 'PUT', renewal)).status, 200);
  const invalid = body('PUT', Date.now() + 50000, { directAddresses: ['127.0.0.1:4433'] });
  invalid.signature = Buffer.alloc(64).toString('base64');
  assert.equal((await request(path, 'PUT', invalid)).status, 401);
} finally {
  assert.equal((await request(path, 'DELETE', body('DELETE', Date.now() + 30000))).status, 200);
}
assert.deepEqual((await request(collection)).body.nodes, []);
const report = {
  base: base.origin, verifiedAt: new Date().toISOString(), milliseconds: Math.round(performance.now() - started),
  tlsVerified: true, health: true, registration: true, discovery: true, renewal: true,
  replayRejected: true, invalidSignatureRejected: true, unregister: true,
};
await writeFile(new URL('../results/discovery-live.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
