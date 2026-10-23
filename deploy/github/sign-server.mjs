import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { signPackage } from './sign-release.mjs';
const input = process.argv[2];
const version = JSON.parse(await readFile(new URL('../../client/package.json', import.meta.url))).version;
const fileName = `RightDataServer-${version}-windows-x64.zip`;
if (basename(input) !== fileName) throw new Error('Unexpected server package name');
const signed = signPackage(await readFile(input), fileName, version, JSON.parse(process.env.RIGHTDATA_UPDATE_SIGNING_KEY));
if (signed.trustedKey !== (await readFile(new URL('../../client/update-public-key.pub', import.meta.url), 'utf8')).trim()) throw new Error('Signing key mismatch');
delete signed.trustedKey;
const manifest = { version, fileName, platform: 'windows', arch: 'x64', ...signed,
  downloadUrl: `https://github.com/${process.env.GITHUB_REPOSITORY || 'WnagoiYy/RightData'}/releases/download/v${version}/${fileName}` };
await writeFile(join(dirname(input), 'latest-server-windows-x64.json'), JSON.stringify(manifest, null, 2));
await writeFile(`${input}.minisig`, signed.signature);
console.log(JSON.stringify({ fileName, size: signed.size, sha256: signed.sha256 }));
