import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const [target] = process.argv.slice(2);
const targets = { 'x86_64-pc-windows-msvc': ['windows', 'x64'], 'aarch64-apple-darwin': ['macos', 'arm64'], 'x86_64-apple-darwin': ['macos', 'x64'] };
if (!targets[target]) throw new Error('Unsupported release target');
const [platform, arch] = targets[target];
const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'client/target'), MACOSX_DEPLOYMENT_TARGET: '12.0' };
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.error || ''}`);
}
const serviceTarget = join(root, 'client/network-service/target');
run('cargo', ['build', '--locked', '--release', '--manifest-path', 'client/network-service/Cargo.toml', '--target-dir', serviceTarget, '--target', target]);
const serviceBinary = join(serviceTarget, target, 'release', `rightdata-network-service${platform === 'windows' ? '.exe' : ''}`);
if (platform === 'windows') {
  const directory = join(root, `client/target/${target}/release`);
  mkdirSync(directory, { recursive: true });
  copyFileSync(serviceBinary, join(directory, 'rightdata-network-service.exe'));
}
if (platform === 'macos') {
  const directory = join(root, 'client/target/macos-resources');
  mkdirSync(directory, { recursive: true });
  const helper = join(directory, 'rightdata-network-service');
  copyFileSync(serviceBinary, helper);
  run('/usr/bin/codesign', ['--force', '--sign', '-', helper]);
}
run(process.execPath, ['scripts/tauri.mjs', 'build', '--ci', '--target', target, '--bundles', platform === 'windows' ? 'nsis' : 'app,dmg'], join(root, 'client'));
const folder = join(root, `client/target/${target}/release/bundle/${platform === 'windows' ? 'nsis' : 'dmg'}`);
const extension = platform === 'windows' ? '.exe' : '.dmg';
const packages = readdirSync(folder).filter(name => name.endsWith(extension));
if (packages.length !== 1) throw new Error(`Expected one package, found ${packages.length}`);
if (platform === 'macos') {
  const apps = join(root, `client/target/${target}/release/bundle/macos`);
  const app = readdirSync(apps).find(name => name.endsWith('.app'));
  if (!app) throw new Error('App bundle missing');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(apps, app)]);
}
run(process.execPath, ['deploy/github/sign-release.mjs', join(folder, packages[0]), platform, arch, 'test/artifacts/release']);
