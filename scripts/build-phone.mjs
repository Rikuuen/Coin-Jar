import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_COINJAR_PHONE: 'true', VITE_COINJAR_HOSTED: 'false' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
