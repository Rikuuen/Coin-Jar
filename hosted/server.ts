import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { createTrackingHandler } from './api';
import { neonSessionAuthenticator } from './auth';
import { handleAuthProxyRequest, processAuthMiddleware, resolveNeonAuthLogging, validateCookieConfig } from '@neon/auth/server';
import { TrackingStore } from './store';
import { validateDatabaseUrl, validateHostedBuild } from './config';
import { createTatumAdapter } from '../server/integrations/tatum.js';
import { backupJournal, backupStatus } from './backup';
import { backupCron } from './backup-cron';

const { DATABASE_URL, NEON_AUTH_BASE_URL, NEON_AUTH_COOKIE_SECRET, COINJAR_ORIGIN } = process.env;
if (!DATABASE_URL || !NEON_AUTH_BASE_URL || !NEON_AUTH_COOKIE_SECRET || !COINJAR_ORIGIN) throw new Error('Hosted database, auth, and origin must be configured');
validateCookieConfig({ secret: NEON_AUTH_COOKIE_SECRET });
validateDatabaseUrl(DATABASE_URL);
validateHostedBuild(await readFile(resolve('dist/index.html'), 'utf8'));
const origin = new URL(COINJAR_ORIGIN);
if (origin.origin !== COINJAR_ORIGIN || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Invalid hosted origin');
const authUrl = new URL(NEON_AUTH_BASE_URL);
if (authUrl.protocol !== 'https:') throw new Error('Invalid auth configuration');
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const role = await pool.query("SELECT rolsuper, rolbypassrls, rolcreaterole, pg_has_role(current_user, 'neon_superuser', 'MEMBER') AS admin_member FROM pg_roles WHERE rolname=current_user");
if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].rolcreaterole || role.rows[0].admin_member) throw new Error('Hosted database role must not have administrative or RLS bypass privileges');
const policies = await pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)", [['coinjar_journals', 'coinjar_entries', 'coinjar_goals', 'coinjar_operations', 'coinjar_entry_voids', 'coinjar_memory_sync']]);
if (policies.rows.length !== 6) throw new Error('Hosted database owner isolation policies are not installed');
const access = await pool.query("SELECT has_table_privilege(current_user, 'coinjar_entry_voids', 'SELECT') AND has_table_privilege(current_user, 'coinjar_entry_voids', 'INSERT') AND NOT has_table_privilege(current_user, 'coinjar_entry_voids', 'UPDATE') AND NOT has_table_privilege(current_user, 'coinjar_entry_voids', 'DELETE') AND has_table_privilege(current_user, 'coinjar_memory_sync', 'SELECT') AND has_table_privilege(current_user, 'coinjar_memory_sync', 'INSERT') AND has_table_privilege(current_user, 'coinjar_memory_sync', 'UPDATE') AND NOT has_table_privilege(current_user, 'coinjar_memory_sync', 'DELETE') AS ready");
if (!access.rows[0]?.ready) throw new Error('Hosted database runtime role lacks required savings permissions');
const tatum = process.env.TATUM_API_KEY ? await createTatumAdapter({ apiKey: process.env.TATUM_API_KEY, network: process.env.SUI_NETWORK ?? 'testnet' }) : undefined;
const handler = createTrackingHandler({ store: new TrackingStore(pool), origin: origin.origin, authenticate: neonSessionAuthenticator(authUrl.href.replace(/\/$/, ''), origin.origin), backupStatus: async (owner) => {
  const encoded = process.env.COINJAR_BACKUP_KEY;
  if (owner !== process.env.COINJAR_BACKUP_OWNER || !encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Invalid backup configuration');
  return backupStatus(owner, key);
}, walletBalance: tatum ? (address) => tatum.getBalance(address) : undefined });
const proxyConfig = { baseUrl: authUrl.href.replace(/\/$/, ''), cookieSecret: NEON_AUTH_COOKIE_SECRET, sameSite: 'lax' as const, log: resolveNeonAuthLogging({ logLevel: 'silent' }) };
const root = resolve('dist');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };
const port = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const bindHost = process.env.COINJAR_BIND_HOST ?? '0.0.0.0';
if (!['127.0.0.1', '0.0.0.0'].includes(bindHost)) throw new Error('Invalid bind host');

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', origin);
    if (url.origin !== origin.origin) { res.writeHead(400).end(); return; }
    if (url.pathname === '/api/backup-cron') {
      const request = new Request(url, { method: req.method, headers: req.headers as HeadersInit });
      const response = await backupCron(request, process.env, (owner, key) => backupJournal(pool, owner, key));
      res.writeHead(response.status, { 'Cache-Control': 'no-store' }).end(await response.text()); return;
    }
    if (url.pathname === '/' && url.searchParams.has('neon_auth_session_verifier')) {
      const request = new Request(url, { headers: req.headers as HeadersInit });
      const result = await processAuthMiddleware({ ...proxyConfig, request, pathname: '/', loginUrl: '/auth/sign-in', skipRoutes: ['/'] });
      if (result.action !== 'allow') { if (result.cookies?.length) res.setHeader('Set-Cookie', result.cookies); res.writeHead(302, { Location: result.redirectUrl.toString() }).end(); return; }
    }
    if (url.pathname.startsWith('/api/auth/')) {
      const path = url.pathname.slice('/api/auth/'.length);
      if (!((req.method === 'GET' && ['get-session', 'token'].includes(path)) || (req.method === 'POST' && ['sign-in/social', 'sign-out'].includes(path)))) { res.writeHead(404).end(); return; }
      if (req.method === 'POST' && req.headers.origin !== origin.origin) { res.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; let length = 0;
      if (req.method === 'POST') for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 4096) { res.writeHead(413).end(); return; } chunks.push(bytes); }
      const request = new Request(url, { method: req.method, headers: req.headers as HeadersInit, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handleAuthProxyRequest({ ...proxyConfig, request, path });
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const request = new Request(url, { method: req.method, headers: req.headers as HeadersInit, ...(req.method === 'POST' ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}) } as RequestInit);
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
if (!process.env.VERCEL) {
  server.listen(port, bindHost, () => console.log(`CoinJar hosted tracking server listening on ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => void pool.end()));
}
export default server;
