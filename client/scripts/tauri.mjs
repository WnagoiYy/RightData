import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, CARGO_TARGET_DIR: resolve(root, 'target') };
if (process.argv[2] === 'dev') {
  const config = env.TAURI_CONFIG ? JSON.parse(env.TAURI_CONFIG) : {};
  env.TAURI_CONFIG = JSON.stringify({ ...config, bundle: { ...config.bundle, resources: {} } });
}
const child = spawn(process.execPath, [resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
