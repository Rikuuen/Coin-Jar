import { spawn } from 'node:child_process';

// A separate database and namespace prevent sample data mixing with real records.
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--env-file-if-exists=.env', 'server/index.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '4320',
      COINJAR_DB: `.data/demo-${Date.now()}.sqlite`,
      COINJAR_MODE: 'demo',
      MEMWAL_NAMESPACE: 'coinjar-demo-php',
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
