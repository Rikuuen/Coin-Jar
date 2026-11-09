import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createPhoneWalrusHandler } from './phone-walrus.mjs';
import { createPhoneTatumHandler } from './phone-tatum.mjs';

const root = resolve('dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const walrus = createPhoneWalrusHandler();
const walrusMainnet = createPhoneWalrusHandler({ network: 'mainnet' });
const tatum = createPhoneTatumHandler();
const server = createServer(async (req, res) => {
  try {
    if (req.url?.split('?')[0] === '/api/phone/walrus') return await (req.headers['x-coinjar-memory-network'] === 'mainnet' ? walrusMainnet(req, res) : walrus(req, res));
    if (req.url?.split('?')[0] === '/api/phone/wallet-balance') return await tatum(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end(); }
});
if (!process.env.VERCEL) server.listen(Number(process.env.PORT ?? 4371), '127.0.0.1');
export default server;
