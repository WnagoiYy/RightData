import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const version = JSON.parse(await readFile('client/package.json')).version;
const tag = `v${version}`;
const repository = process.env.GITHUB_REPOSITORY || 'WnagoiYy/RightData';
const buildSha = process.env.RIGHTDATA_BUILD_SHA || process.env.GITHUB_SHA;
const tagCommit = spawnSync('gh', ['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'], { encoding: 'utf8' });
if (tagCommit.status !== 0 || tagCommit.stdout.trim() !== buildSha) throw new Error('Create the version tag at the verified build commit before publishing');
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
// The existing tag already pins the source commit. Sending an older target_commitish
// additionally requires workflow-write permission that GITHUB_TOKEN cannot obtain.
const result = spawnSync('gh', ['release', 'create', tag, ...files.map(file => `${directory}/${file}`), '--verify-tag',
  '--title', `RightData ${version}`, '--notes-file', 'deploy/github/release-notes.md'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Release publication failed; existing releases are never overwritten');
