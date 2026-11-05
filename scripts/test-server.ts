import { createApp } from '../server/app';

// Test-only quote, never used by the application server.
const fx = {
  getRate: async () => ({
    value: '0.017',
    basePair: 'USD' as const,
    symbol: 'PHP' as const,
    timestamp: Date.now(),
    source: 'test',
  }),
};
const app = createApp({
  dbPath: process.env.COINJAR_DB,
  env: { COINJAR_MODE: 'demo' },
  fx,
});
app.server.listen(4319, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
