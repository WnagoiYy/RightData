import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function signPackage(bytes, fileName, version, secret) {
  const key = createPrivateKey(secret.privateKey);
  const publicKey = createPublicKey(key);
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const id = Buffer.from(secret.keyId, 'hex');
  if (id.length !== 8) throw new Error('Invalid signing key ID');
  const trustedKey = Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64');
  const digest = createHash('blake2b512').update(bytes).digest();
  const signature = sign(null, digest, key);
  const comment = `version:${version}\tfile:${fileName}\tprehashed`;
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(comment)]), key);
  if (!verify(null, digest, publicKey, signature)) throw new Error('Signature self-check failed');
  const text = `untrusted comment: RightData release signature\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${comment}\n${globalSignature.toString('base64')}\n`;
  return { trustedKey, signature: text, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

async function main() {
  const [input, platform, arch, output] = process.argv.slice(2);
  if (!input || !output || !['windows-x64', 'macos-arm64', 'macos-x64'].includes(`${platform}-${arch}`)) throw new Error('Usage: sign-release.mjs package platform arch output-dir');
  const version = JSON.parse(await readFile(new URL('../../client/package.json', import.meta.url))).version;
  const repository = process.env.GITHUB_REPOSITORY || 'WnagoiYy/RightData';
  const fileName = `RightData-${version}-${platform}-${arch}.${platform === 'windows' ? 'exe' : 'dmg'}`;
  const bytes = await readFile(input);
  const signed = signPackage(bytes, fileName, version, JSON.parse(process.env.RIGHTDATA_UPDATE_SIGNING_KEY || 'null'));
  const expected = (await readFile(new URL('../../client/update-public-key.pub', import.meta.url), 'utf8')).trim();
  if (expected !== signed.trustedKey) throw new Error('Release secret does not match the embedded public key');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, fileName), bytes);
  await writeFile(resolve(output, `${fileName}.minisig`), signed.signature);
  const manifest = { id: `github-${version.replaceAll('.', '-')}-${platform}-${arch}`, version, platform, arch, ...signed, fileName,
    downloadUrl: `https://github.com/${repository}/releases/download/v${version}/${fileName}`, notes: `RightData ${version}` };
  delete manifest.trustedKey;
  await writeFile(resolve(output, `latest-${platform}-${arch}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ file: basename(fileName), size: signed.size, sha256: signed.sha256 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
