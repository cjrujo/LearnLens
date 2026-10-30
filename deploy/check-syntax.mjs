import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['server.mjs'];
for (const directory of ['lib', 'deploy', 'tests', 'public']) {
  for (const name of await readdir(directory)) if (/\.(?:mjs|js)$/.test(name)) files.push(`${directory}/${name}`);
}
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status || 1); }
console.log(`Syntax checks passed (${files.length} files).`);
