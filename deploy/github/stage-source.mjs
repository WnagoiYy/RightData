// Prepare the public checkout without creating Git metadata at the workspace root.
import { mkdir, readdir, copyFile, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
const root = resolve('.');
const destination = join(root, 'deploy/github/repository');
const excludedNames = new Set(['node_modules', 'target', 'dist', 'dist-ssr', '__pycache__', '.git', '.idea', '.vscode', '.staging']);
const excludedPaths = ['server/data', 'server/bin', 'server/runtime', 'server/manifest/output', 'client/src-tauri/gen', 'test/runtime', 'test/results', 'test/build', 'test/artifacts', 'test/doc', 'test/client/config-results', 'deploy/github/repository'];
const files = [];
async function collect(relative) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (excludedNames.has(entry.name) || excludedPaths.some(prefix => path === prefix || path.startsWith(prefix + '/'))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (entry.isDirectory()) { await collect(path); continue; }
    if (/\.(exe~?|dll|pdb|pyc|log|duckdb|duckdb_extension|zip|dmg|credential|key|pem)$/i.test(path) || /(^|\/)\.env($|\.)/.test(path) || path === 'server/manifest/config/config.yaml') continue;
    if ((await lstat(join(root, path))).size > 20 * 1024 * 1024) throw new Error(`Review large source file: ${path}`);
    files.push(path);
  }
}
for (const directory of ['server', 'client', 'deploy', 'test']) await collect(directory);
files.push('AGENTS.md');
const suspicious = [];
for (const file of files) {
  if (/\.(rs|ts|tsx|js|mjs|cjs|json|yaml|yml|md|go|ps1|html|toml|py)$/i.test(file)) {
    const content = await readFile(join(root, file), 'utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\bAKIA[A-Z0-9]{16}\b/.test(content)) suspicious.push(file);
  }
}
if (suspicious.length) throw new Error(`Credential-shaped source requires review: ${suspicious.join(', ')}`);
for (const file of files) {
  const target = join(destination, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, file), target);
}
await mkdir(join(destination, '.github/workflows'), { recursive: true });
await copyFile(join(root, 'deploy/github/workflows/release.yml'), join(destination, '.github/workflows/release.yml'));
await copyFile(join(root, 'deploy/github/workflows/verify-release.yml'), join(destination, '.github/workflows/verify-release.yml'));
await mkdir(join(destination, 'server/manifest/config'), { recursive: true });
await writeFile(join(destination, 'server/manifest/config/config.example.yaml'), 'server:\n  address: ":8003"\n  openapiPath: "/api/api.json"\n  swaggerPath: "/api/swagger"\nlogger:\n  level: "info"\n  stdout: true\nrightdata:\n  dataDir: "data"\n  adminUsername: "admin"\n  cookieSecure: true\n');
await writeFile(join(destination, '.gitignore'), 'node_modules/\ntarget/\ndist/\n__pycache__/\n*.log\n*.exe\n*.exe~\n*.dll\n*.pdb\n*.credential\n*.duckdb*\n.env*\n/server/data/\n/server/bin/\n/server/.staging/\n/server/manifest/config/config.yaml\n/client/src-tauri/gen/\n/test/runtime/\n/test/results/\n/test/build/\n/test/artifacts/\n/test/client/config-results/\n/deploy/github/repository/\n');
await writeFile(join(destination, 'AGENTS.md'), (await readFile(join(root, 'AGENTS.md'), 'utf8')) + '\n\n## GitHub 发布仓库例外\n`.github/workflows/` 与根目录 `.gitignore` 是 GitHub 自动构建所需的固定路径；工作流源文件维护在 `deploy/github/workflows/`。\n');
await mkdir(join(root, 'test/results'), { recursive: true });
await writeFile(join(root, 'test/results/public-source-inventory.json'), JSON.stringify({ count: files.length, excludedPaths, files }, null, 2));
console.log(`Staged ${files.length} source files; runtime data, private keys, local transcripts, caches and packages excluded.`);
