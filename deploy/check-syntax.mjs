import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['server.mjs', 'public/app.js'];
for (const directory of ['lib', 'deploy', 'tests']) {
  for (const name of await readdir(directory)) if (name.endsWith('.mjs')) files.push(`${directory}/${name}`);
}
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status || 1); }
console.log(`Syntax checks passed (${files.length} files).`);
