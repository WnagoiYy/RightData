// Run locally once. Only the public key enters source control.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { github } from './github-api.mjs';
const directory = 'test/runtime/release-secrets';
const file = `${directory}/update-key.json`;
await mkdir(directory, { recursive: true });
let secret;
try { secret = JSON.parse(await readFile(file, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const pair = generateKeyPairSync('ed25519');
  secret = { keyId: randomBytes(8).toString('hex'), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
  await writeFile(file, JSON.stringify(secret), { flag: 'wx', mode: 0o600 });
}
const publicText = Buffer.concat([Buffer.from('Ed'), Buffer.from(secret.keyId, 'hex'), Buffer.from(secret.publicKey, 'base64')]).toString('base64');
try {
  const existing = (await readFile('client/update-public-key.pub', 'utf8')).trim();
  if (existing !== publicText) throw new Error('Refusing to replace a different trusted key');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile('client/update-public-key.pub', publicText + '\n');
const githubKey = await github('/repos/WnagoiYy/RightData/actions/secrets/public-key');
const python = process.env.RIGHTDATA_PYTHON || 'python3';
const sealed = spawnSync(python, ['-c', 'import sys,json,base64;sys.path.insert(0,"test/runtime/python-tools");from nacl.public import PublicKey,SealedBox;d=json.load(sys.stdin);print(base64.b64encode(SealedBox(PublicKey(base64.b64decode(d["key"]))).encrypt(d["secret"].encode())).decode())'],
  { input: JSON.stringify({ key: githubKey.key, secret: JSON.stringify(secret) }), encoding: 'utf8', windowsHide: true });
if (sealed.status !== 0) throw new Error('Could not encrypt the release secret');
await github('/repos/WnagoiYy/RightData/actions/secrets/RIGHTDATA_UPDATE_SIGNING_KEY', { method: 'PUT', body: { key_id: githubKey.key_id, encrypted_value: sealed.stdout.trim() } });
console.log('Release signing public key saved; matching private key stored in GitHub Actions secret.');
