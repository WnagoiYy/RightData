import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const version = JSON.parse(await readFile('client/package.json')).version;
const tag = `v${version}`;
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag) throw new Error('Tag and package version differ');
const directory = 'test/artifacts/release';
const files = await readdir(directory);
for (const target of ['windows-x64', 'macos-arm64', 'macos-x64']) {
  const manifest = JSON.parse(await readFile(`${directory}/latest-${target}.json`));
  if (manifest.version !== version || !files.includes(manifest.fileName) || !files.includes(`${manifest.fileName}.minisig`)) throw new Error(`Incomplete ${target}`);
}
const result = spawnSync('gh', ['release', 'create', tag, ...files.map(file => `${directory}/${file}`), '--target', process.env.GITHUB_SHA,
  '--title', `RightData ${version}`, '--notes', 'Windows x64、macOS Apple Silicon、macOS Intel。安装包不包含 WebView 运行时；macOS 使用 ad-hoc 签名，未公证。更新安装包附带 Minisign 签名与 SHA-256 清单。'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Release publication failed; existing releases are never overwritten');
