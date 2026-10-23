import { spawnSync } from 'node:child_process';

let cachedToken;
function token() {
  if (cachedToken) return cachedToken;
  const supplied = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (supplied) return (cachedToken = supplied);
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, windowsHide: true,
  });
  const password = result.stdout?.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
  if (result.status !== 0 || !password) throw new Error('No non-interactive GitHub credential is available.');
  return (cachedToken = password);
}

export async function github(path, { method = 'GET', body, headers = {} } = {}) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('GitHub API path required.');
  const response = await fetch(`https://api.github.com${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'RightData-Publisher', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${data?.message || 'request failed'}`);
  return data;
}
