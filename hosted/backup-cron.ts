import { timingSafeEqual } from 'node:crypto';

type RunBackup = (owner: string, key: Buffer) => Promise<unknown>;

export function backupCron(request: Request, env: NodeJS.ProcessEnv, run: RunBackup): Promise<Response> | Response {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < 32) return new Response('Backup not configured', { status: 503 });
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (request.method !== 'GET' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response('Unauthorized', { status: 401 });
  const owner = env.COINJAR_BACKUP_OWNER;
  const encodedKey = env.COINJAR_BACKUP_KEY;
  if (!owner || !encodedKey || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) return new Response('Backup not configured', { status: 503 });
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) return new Response('Backup not configured', { status: 503 });
  return run(owner, key).then(() => new Response('Backup verified', { status: 200 }), () => new Response('Backup failed', { status: 503 }));
}
