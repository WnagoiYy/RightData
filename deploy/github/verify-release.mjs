import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repository = 'WnagoiYy/RightData';
const requestedVersion = process.env.RIGHTDATA_VERIFY_VERSION || '';
if (requestedVersion && !/^\d+\.\d+\.\d+$/.test(requestedVersion)) throw new Error('Invalid requested version');
const apiUrl = `https://api.github.com/repos/${repository}/releases/${requestedVersion ? `tags/v${requestedVersion}` : 'latest'}`;
let release;
if (process.env.RIGHTDATA_VERIFY_CURL === '1') {
  const result = spawnSync('curl', ['--fail', '--silent', '--show-error', '--retry', '3', '--retry-all-errors', '--max-time', '30', apiUrl], { encoding: 'utf8', windowsHide: true, maxBuffer: 1048576 });
  if (result.status !== 0) throw new Error('Unable to read public release metadata');
  release = JSON.parse(result.stdout);
} else {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(apiUrl, { redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`Release metadata HTTP ${response.status}`);
  release = await response.json();
}
const version = release.tag_name.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
const output = resolve(`test/artifacts/release-${version}`);
await mkdir(output, { recursive: true });
const trusted = Buffer.from((await readFile('client/update-public-key.pub', 'utf8')).trim(), 'base64');
if (trusted.length !== 42 || trusted.subarray(0, 2).toString() !== 'Ed') throw new Error('Invalid trusted public key');
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), trusted.subarray(10)]), format: 'der', type: 'spki' });

async function download(address, limit) {
  let url = new URL(address);
  for (let count = 0; count < 6; count++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('Unexpected release host');
    if (url.hostname === 'github.com' && !url.pathname.startsWith(`/${repository}/releases/`)) throw new Error('Unexpected release repository');
    if (process.env.RIGHTDATA_VERIFY_CURL === '1') {
      const bodyPath = resolve(output, '.verify-body');
      const headersPath = resolve(output, '.verify-headers');
      try {
        const result = spawnSync('curl', ['--silent', '--show-error', '--retry', '3', '--retry-all-errors', '--retry-delay', '1', '--retry-max-time', '45', '--max-time', '120', '--max-filesize', String(limit), '--proto', '=https', '--dump-header', headersPath, '--output', bodyPath, '--write-out', '%{http_code}', url.href], { encoding: 'utf8', windowsHide: true });
        if (result.status !== 0) throw new Error(`curl transfer failed (${result.status}): ${result.stderr.slice(0, 200)}`);
        const status = Number(result.stdout.trim());
        if ([301, 302, 303, 307, 308].includes(status)) {
          const headers = await readFile(headersPath, 'utf8');
          const location = [...headers.matchAll(/^location:\s*(.+)$/gim)].at(-1)?.[1]?.trim();
          if (!location) throw new Error('Missing redirect location');
          url = new URL(location, url);
          continue;
        }
        if (status !== 200) throw new Error(`Download HTTP ${status}`);
        const bytes = await readFile(bodyPath);
        if (bytes.length > limit) throw new Error('Release response exceeds expected size');
        return bytes;
      } finally {
        await Promise.all([bodyPath, headersPath].map(path => unlink(path).catch(() => {})));
      }
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get('location'), url); continue; }
    if (response.status !== 200) throw new Error(`Download HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Release response exceeds expected size');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many release redirects');
}

const results = [];
for (const target of ['windows-x64', 'macos-arm64', 'macos-x64', 'server-windows-x64', 'server-linux-x64']) {
  const isServer = target.startsWith('server-');
  const [platform, arch] = (isServer ? target.slice(7) : target).split('-');
  const manifestName = `latest-${target}.json`;
  // Exercise the exact latest URL used by the client, including GitHub redirects.
  const manifestPath = requestedVersion ? `download/v${version}` : 'latest/download';
  const manifest = JSON.parse(await download(`https://github.com/${repository}/releases/${manifestPath}/${manifestName}`, 262144));
  const name = isServer ? `RightDataServer-${version}-${platform}-x64.${platform === 'windows' ? 'zip' : 'tar.gz'}` : `RightData-${version}-${target}.${platform === 'windows' ? 'exe' : 'dmg'}`;
  const asset = release.assets.find(item => item.name === name);
  if (!asset || manifest.fileName !== name || manifest.version !== version || manifest.platform !== platform || manifest.arch !== arch || manifest.downloadUrl !== asset.browser_download_url || manifest.size !== asset.size || `sha256:${manifest.sha256}` !== asset.digest) throw new Error(`Release metadata mismatch: ${target}`);
  const bytes = await download(manifest.downloadUrl, asset.size);
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error(`Package digest mismatch: ${target}`);
  const lines = manifest.signature.trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid Minisign document');
  const signature = Buffer.from(lines[1], 'base64');
  if (signature.length !== 74 || signature.subarray(0, 2).toString() !== 'ED' || !signature.subarray(2, 10).equals(trusted.subarray(2, 10))) throw new Error('Unexpected signing identity');
  if (!verify(null, createHash('blake2b512').update(bytes).digest(), key, signature.subarray(10)) || !verify(null, Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]), key, Buffer.from(lines[3], 'base64'))) throw new Error(`Signature verification failed: ${target}`);
  const sidecar = await download(`${manifest.downloadUrl}.minisig`, 4096);
  if (sidecar.toString().trim() !== manifest.signature.trim()) throw new Error('Signature sidecar differs from manifest');
  await writeFile(resolve(output, name), bytes);
  await writeFile(resolve(output, `${name}.minisig`), sidecar);
  await writeFile(resolve(output, manifestName), JSON.stringify(manifest, null, 2));
  results.push({ target, file: name, size: bytes.length, sha256: manifest.sha256, verified: true });
}
await mkdir('test/results', { recursive: true });
await writeFile('test/results/release-verification.json', JSON.stringify({ release: release.html_url, version, verifiedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
