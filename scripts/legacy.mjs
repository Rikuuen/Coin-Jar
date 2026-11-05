import { spawn } from 'node:child_process';

// Keep the original USD journal and its memories available without conversion.
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--env-file-if-exists=.env', 'server/index.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '4321',
      COINJAR_DB: '.data/coinjar.sqlite',
      MEMWAL_NAMESPACE: 'coinjar-v1',
      COINJAR_ALLOW_SETUP: '0',
    },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
