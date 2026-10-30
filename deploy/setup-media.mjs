import { spawn } from 'node:child_process';
import { ensureMediaTools, mediaChildEnvironment } from './media-assets.mjs';
import { loadProjectEnv } from './native-start.mjs';
loadProjectEnv();
try {
  console.log('Preparing project-local media tools. The first run downloads verified upstream assets.');
  const tools = await ensureMediaTools();
  for (const executable of [tools.ffmpeg, tools.ffprobe]) await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-version'], { shell: false, windowsHide: true, env: mediaChildEnvironment(), stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Managed media tools could not start on this host.')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Managed media tools failed the local startup check.')); });
  });
  console.log('Managed media tools are ready. Later imports use the verified local cache.');
} catch (error) { console.error(error.name === 'MediaImportError' ? error.message : 'Media setup failed. Check the host, available storage and network; no provider request was made.'); process.exitCode = 1; }
