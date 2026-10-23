import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { signPackage } from '../../deploy/github/sign-release.mjs';
import { verifyPackage } from '../../deploy/server/update-server.mjs';
const { privateKey } = generateKeyPairSync('ed25519');
const secret = { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: randomBytes(8).toString('hex') };
const bytes = Buffer.from('signed server archive fixture');
const fileName = 'RightDataServer-0.1.2-windows-x64.zip';
const signed = signPackage(bytes, fileName, '0.1.2', secret);
const manifest = { version: '0.1.2', fileName, ...signed };
test('accepts authentic server package', () => verifyPackage(manifest, bytes, signed.trustedKey));
test('rejects altered bytes, hash-only substitution and release relabeling', () => {
  assert.throws(() => verifyPackage(manifest, Buffer.from('altered'), signed.trustedKey));
  const other = signPackage(Buffer.from('different'), fileName, '0.1.2', secret);
  assert.throws(() => verifyPackage({ ...manifest, sha256: other.sha256, size: 9 }, Buffer.from('different'), signed.trustedKey));
  assert.throws(() => verifyPackage({ ...manifest, version: '0.1.3', fileName: 'RightDataServer-0.1.3-windows-x64.zip' }, bytes, signed.trustedKey));
});
