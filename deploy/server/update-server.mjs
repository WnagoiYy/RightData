import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyPackage(manifest, bytes, publicText) {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.fileName !== `RightDataServer-${manifest.version}-windows-x64.zip` || manifest.size !== bytes.length || bytes.length > 536870912) throw new Error('Invalid server package metadata');
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Package checksum mismatch');
  const trusted = Buffer.from(publicText.trim(), 'base64');
  const lines = manifest.signature.trim().split(/\r?\n/);
  const signature = Buffer.from(lines[1] || '', 'base64');
  const comment = `version:${manifest.version}\tfile:${manifest.fileName}\tprehashed`;
  if (trusted.length !== 42 || trusted.subarray(0, 2).toString() !== 'Ed' || signature.length !== 74 || signature.subarray(0, 2).toString() !== 'ED' || !signature.subarray(2, 10).equals(trusted.subarray(2, 10)) || lines.length !== 4 || lines[2] !== `trusted comment: ${comment}`) throw new Error('Invalid signing identity or release binding');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), trusted.subarray(10)]), type: 'spki', format: 'der' });
  if (!verify(null, createHash('blake2b512').update(bytes).digest(), key, signature.subarray(10)) || !verify(null, Buffer.concat([signature.subarray(10), Buffer.from(comment)]), key, Buffer.from(lines[3], 'base64'))) throw new Error('Package signature mismatch');
}
function powershell(script, args = []) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 1048576 });
  if (result.status !== 0) throw new Error(`Deployment command failed: ${(result.stderr || result.stdout).slice(-1500)}`);
  return result.stdout.trim();
}
async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  if (resolve(root).toLowerCase() !== 'c:\\programdata\\rightdataserver') throw new Error('Unexpected deployment root');
  const config = { repository: 'WnagoiYy/RightData' };
  const local = process.argv[2] === '--package-dir' ? resolve(process.argv[3]) : null;
  if (!local || !local.toLowerCase().startsWith(join(root, 'downloads').toLowerCase() + '\\')) throw new Error('SSH-uploaded package directory is required');
  let status;
  try {
    const manifestName = 'latest-server-windows-x64.json';
    const manifest = JSON.parse(await readFile(join(local, manifestName)));
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid version');
    const current = await readFile(join(root, 'current.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current) {
      const compare = manifest.version.split('.').map(Number).reduce((value, part, index) => value || Math.sign(part - Number(current.version.split('.')[index])), 0);
      if (compare <= 0) { status = { unchanged: true, version: current.version }; return; }
    }
    if (manifest.downloadUrl !== `https://github.com/${config.repository}/releases/download/v${manifest.version}/RightDataServer-${manifest.version}-windows-x64.zip`) throw new Error('Unexpected package URL');
    const bytes = await readFile(join(local, manifest.fileName));
    verifyPackage(manifest, bytes, await readFile(join(root, 'update-public-key.pub'), 'utf8'));
    const archive = join(root, 'downloads', manifest.fileName);
    await writeFile(archive, bytes);
    const destination = join(root, 'releases', manifest.version);
    // An interrupted extraction may be safely overwritten only after verifying the same signed archive.
    powershell(['-File', join(root, 'extract.ps1')], ['-Archive', archive, '-Destination', destination]);
    const activated = powershell(['-File', join(root, 'activate.ps1')], ['-Version', manifest.version]);
    status = { version: manifest.version, sha256: manifest.sha256, activated };
  } catch (error) { status = { error: error.message }; throw error; }
  finally {
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(join(root, 'logs/deploy-status.tmp'), JSON.stringify({ ...status, checkedAt: new Date().toISOString() }, null, 2));
    await rename(join(root, 'logs/deploy-status.tmp'), join(root, 'logs/deploy-status.json'));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
