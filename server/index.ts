import { createApp } from './app';
const port = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be between 1024 and 65535.');
const app = createApp({
  configFile: process.env.COINJAR_ALLOW_SETUP === '0' ? undefined : '.env',
});
app.server.listen(port, '127.0.0.1', () =>
  console.log(`CoinJar local demo: http://127.0.0.1:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
