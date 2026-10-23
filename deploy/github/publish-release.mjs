import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const version = JSON.parse(await readFile('client/package.json')).version;
const tag = `v${version}`;
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag) throw new Error('Tag and package version differ');
const directory = 'test/artifacts/release';
const files = await readdir(directory);
for (const platform of ['windows', 'linux']) {
  const server = JSON.parse(await readFile(`${directory}/latest-server-${platform}-x64.json`));
  if (server.version !== version || !files.includes(server.fileName) || !files.includes(`${server.fileName}.minisig`)) throw new Error(`Incomplete ${platform} server package`);
}
for (const target of ['windows-x64', 'macos-arm64', 'macos-x64']) {
  const manifest = JSON.parse(await readFile(`${directory}/latest-${target}.json`));
  if (manifest.version !== version || !files.includes(manifest.fileName) || !files.includes(`${manifest.fileName}.minisig`)) throw new Error(`Incomplete ${target}`);
}
const result = spawnSync('gh', ['release', 'create', tag, ...files.map(file => `${directory}/${file}`), '--target', process.env.GITHUB_SHA,
  '--title', `RightData ${version}`, '--notes', '修复 Windows 安装程序在 32/64 位进程和远程桌面会话中识别登录用户失败的问题。客户端 Windows x64、macOS Apple Silicon、macOS Intel；后端 Windows x64、Linux x64。Linux 包包含离线 DuckDB 扩展、systemd 服务及安装说明，面向海光 C86 / BC Linux，具体系统须通过随包兼容性预检。正式客户端默认连接 192.168.3.123:8003，开发构建使用本机 8003，已保存的连接设置保持不变。客户端安装包不包含 WebView 运行时；macOS 使用 ad-hoc 签名。所有发布包附带 Minisign 签名和 SHA-256 清单。'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Release publication failed; existing releases are never overwritten');
