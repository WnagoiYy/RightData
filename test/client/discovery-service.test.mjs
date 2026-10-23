import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';

import { createDiscoveryServer, signatureMessage } from '../../deploy/discovery/server.mjs';

const NODE_PROTOCOL = 'rightdata/relay/1';
const DISCOVERY_PROTOCOL = 'rightdata/discovery/1';

function createIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, endpointId: spki.subarray(-32).toString('hex') };
}

function signedBody(identity, method, path, expiresAt, fields = {}) {
  const payload = {
    protocol: NODE_PROTOCOL,
    endpointId: identity.endpointId,
    ...fields,
    expiresAt,
  };
  return {
    ...payload,
    signature: sign(null, signatureMessage(method, path, expiresAt, payload), identity.privateKey).toString('base64'),
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options.body === undefined ? options : {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

async function withServer(options, run) {
  const server = createDiscoveryServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('registers, lists, and removes a signed endpoint without exposing its signature', async () => {
  let now = 1_800_000_000_000;
  await withServer({ now: () => now }, async baseUrl => {
    const identity = createIdentity();
    const path = `/v1/instances/demo/nodes/${identity.endpointId}`;
    const expiresAt = now + 90_000;
    const registration = signedBody(identity, 'PUT', path, expiresAt, {
      directAddresses: ['127.0.0.1:4433', '[2001:db8::20]:4433'],
      relayUrl: 'https://relay.example.test',
    });

    const put = await requestJson(baseUrl, path, { method: 'PUT', body: registration });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, {
      protocol: DISCOVERY_PROTOCOL,
      registered: true,
      expiresAt: now + 60_000,
    });

    const list = await requestJson(baseUrl, '/v1/instances/demo/nodes');
    assert.equal(list.status, 200);
    assert.equal(list.body.protocol, DISCOVERY_PROTOCOL);
    assert.equal(list.body.instanceId, 'demo');
    assert.equal(list.body.generatedAt, now);
    assert.deepEqual(list.body.nodes, [{
      protocol: NODE_PROTOCOL,
      endpointId: identity.endpointId,
      directAddresses: registration.directAddresses,
      relayUrl: 'https://relay.example.test/',
      expiresAt: now + 60_000,
    }]);
    assert.equal('signature' in list.body.nodes[0], false);

    now += 1;
    const removal = signedBody(identity, 'DELETE', path, now + 30_000);
    const deleted = await requestJson(baseUrl, path, { method: 'DELETE', body: removal });
    assert.deepEqual(deleted, {
      status: 200,
      body: { protocol: DISCOVERY_PROTOCOL, removed: true },
    });
    const empty = await requestJson(baseUrl, '/v1/instances/demo/nodes');
    assert.deepEqual(empty.body.nodes, []);
  });
});

test('caps leases at 60 seconds and prunes expired endpoint records', async () => {
  let now = 1_800_000_000_000;
  await withServer({ now: () => now }, async baseUrl => {
    const identity = createIdentity();
    const path = `/v1/instances/lease/nodes/${identity.endpointId}`;
    const registration = signedBody(identity, 'PUT', path, now + 90_000, {
      directAddresses: ['10.0.0.5:4433'],
    });
    assert.equal((await requestJson(baseUrl, path, { method: 'PUT', body: registration })).status, 200);

    now += 59_999;
    assert.equal((await requestJson(baseUrl, '/v1/instances/lease/nodes')).body.nodes.length, 1);
    now += 1;
    assert.deepEqual((await requestJson(baseUrl, '/v1/instances/lease/nodes')).body.nodes, []);
  });
});

test('rejects replayed, malformed, invalid, expired, and overlong signatures', async () => {
  const now = 1_800_000_000_000;
  await withServer({ now: () => now }, async baseUrl => {
    const identity = createIdentity();
    const path = `/v1/instances/security/nodes/${identity.endpointId}`;
    const valid = signedBody(identity, 'PUT', path, now + 30_000, { directAddresses: [] });
    assert.equal((await requestJson(baseUrl, path, { method: 'PUT', body: valid })).status, 200);

    const replay = await requestJson(baseUrl, path, { method: 'PUT', body: valid });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, 'replayed_signature');

    const otherIdentity = createIdentity();
    const wrongSigner = signedBody(otherIdentity, 'PUT', `/v1/instances/security/nodes/${otherIdentity.endpointId}`, now + 30_001, { directAddresses: [] });
    wrongSigner.endpointId = identity.endpointId;
    const invalid = await requestJson(baseUrl, path, { method: 'PUT', body: wrongSigner });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.code, 'signature_invalid');

    const malformed = signedBody(identity, 'DELETE', path, now + 30_002);
    malformed.signature += 'A';
    const malformedResult = await requestJson(baseUrl, path, { method: 'DELETE', body: malformed });
    assert.equal(malformedResult.status, 400);
    assert.equal(malformedResult.body.code, 'invalid_signature');

    const expired = signedBody(identity, 'DELETE', path, now);
    const expiredResult = await requestJson(baseUrl, path, { method: 'DELETE', body: expired });
    assert.equal(expiredResult.status, 401);
    assert.equal(expiredResult.body.code, 'expired_signature');

    const tooFar = signedBody(identity, 'DELETE', path, now + 90_001);
    const tooFarResult = await requestJson(baseUrl, path, { method: 'DELETE', body: tooFar });
    assert.equal(tooFarResult.status, 400);
    assert.equal(tooFarResult.body.code, 'expiry_too_far');
  });
});

test('rejects identity mismatches, unsafe endpoint data, and unknown secret-bearing fields', async () => {
  const now = 1_800_000_000_000;
  await withServer({ now: () => now }, async baseUrl => {
    const identity = createIdentity();
    const otherIdentity = createIdentity();
    const path = `/v1/instances/validation/nodes/${identity.endpointId}`;

    const mismatch = signedBody(otherIdentity, 'PUT', path, now + 30_000, { directAddresses: [] });
    const mismatchResult = await requestJson(baseUrl, path, { method: 'PUT', body: mismatch });
    assert.equal(mismatchResult.status, 400);
    assert.equal(mismatchResult.body.code, 'endpoint_mismatch');

    const hostname = signedBody(identity, 'PUT', path, now + 30_001, {
      directAddresses: ['host.internal:4433'],
    });
    const hostnameResult = await requestJson(baseUrl, path, { method: 'PUT', body: hostname });
    assert.equal(hostnameResult.status, 400);
    assert.equal(hostnameResult.body.code, 'invalid_direct_addresses');

    const unsorted = signedBody(identity, 'PUT', path, now + 30_002, {
      directAddresses: ['[::1]:4433', '127.0.0.1:4433'],
    });
    const unsortedResult = await requestJson(baseUrl, path, { method: 'PUT', body: unsorted });
    assert.equal(unsortedResult.status, 400);
    assert.equal(unsortedResult.body.code, 'direct_addresses_order');

    for (const forbiddenField of ['token', 'backendUrl']) {
      const body = signedBody(identity, 'PUT', path, now + 30_003, { directAddresses: [] });
      body[forbiddenField] = 'must-not-be-accepted';
      const result = await requestJson(baseUrl, path, { method: 'PUT', body });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'unknown_field');
    }

    const unsafeRelay = signedBody(identity, 'PUT', path, now + 30_004, {
      directAddresses: [],
      relayUrl: 'https://user:secret@relay.example.test/path#fragment',
    });
    const relayResult = await requestJson(baseUrl, path, { method: 'PUT', body: unsafeRelay });
    assert.equal(relayResult.status, 400);
    assert.equal(relayResult.body.code, 'invalid_relay_url');
  });
});

test('enforces request body and per-IP rate limits', async () => {
  await withServer({ maxBodyBytes: 32 }, async baseUrl => {
    const identity = createIdentity();
    const path = `/v1/instances/limits/nodes/${identity.endpointId}`;
    const oversized = await requestJson(baseUrl, path, {
      method: 'PUT',
      body: JSON.stringify({ padding: 'x'.repeat(64) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, 'payload_too_large');
  });

  await withServer({ rateLimitMax: 2 }, async baseUrl => {
    assert.equal((await requestJson(baseUrl, '/healthz')).status, 200);
    assert.equal((await requestJson(baseUrl, '/healthz')).status, 200);
    const limited = await requestJson(baseUrl, '/healthz');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'rate_limited');
  });
});
