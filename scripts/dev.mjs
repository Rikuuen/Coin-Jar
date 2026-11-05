import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [
  spawn(
    process.execPath,
    ['--import', 'tsx', '--env-file-if-exists=.env', 'server/index.ts'],
    { cwd: root, stdio: 'inherit' },
  ),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    cwd: root,
    stdio: 'inherit',
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => child.kill());
  process.exitCode = code;
}
children.forEach((child) => {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 0));
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
