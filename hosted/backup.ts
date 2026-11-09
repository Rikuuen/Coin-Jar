import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { del, get, list, put } from '@vercel/blob';
import type { Pool } from 'pg';
import { decryptArchive, encryptArchive, exportJournal } from './recovery';

type BackupStorage = {
  write(path: string, data: Buffer): Promise<void>;
  read(path: string): Promise<Buffer>;
  list(prefix: string): Promise<{ path: string; uploadedAt: Date }[]>;
  remove(paths: string[]): Promise<void>;
};

export const privateBlobStorage: BackupStorage = {
  async write(path, data) {
    await put(path, data, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/octet-stream' });
  },
  async read(path) {
    const result = await get(path, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) throw new Error('Backup read failed');
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  },
  async list(prefix) {
    const blobs: { path: string; uploadedAt: Date }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor });
      blobs.push(...page.blobs.map(blob => ({ path: blob.pathname, uploadedAt: blob.uploadedAt })));
      if (page.hasMore && !page.cursor) throw new Error('Backup listing incomplete');
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  },
  async remove(paths) { if (paths.length) await del(paths); },
};

function ownerPrefix(owner: string, key: Buffer): string {
  if (!owner || owner.length > 255 || key.length !== 32) throw new Error('Invalid backup configuration');
  return `coinjar/${createHmac('sha256', key).update(owner).digest('hex')}/`;
}

function isArchive(path: string, prefix: string): boolean {
  return path.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.enc$/i.test(path.slice(prefix.length));
}

export async function backupJournal(pool: Pool, owner: string, key: Buffer, storage: BackupStorage = privateBlobStorage): Promise<{ path: string; revision: string }> {
  if (key.length !== 32) throw new Error('Invalid backup key');
  const archive = await exportJournal(pool, owner);
  const revision = archive.rows.coinjar_journals[0].revision;
  if (typeof revision !== 'string' || !/^\d+$/.test(revision)) throw new Error('Invalid journal revision');
  const path = `${ownerPrefix(owner, key)}${new Date().toISOString().slice(0, 10)}/${randomUUID()}.enc`;
  const encrypted = encryptArchive(archive, key);
  await storage.write(path, encrypted);
  const retrieved = await storage.read(path);
  if (retrieved.length !== encrypted.length || !timingSafeEqual(retrieved, encrypted)) throw new Error('Backup verification failed');
  decryptArchive(retrieved, key);
  const prefix = ownerPrefix(owner, key), cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const expired = (await storage.list(prefix)).filter(item => item.path !== path && isArchive(item.path, prefix) && Number.isFinite(item.uploadedAt.getTime()) && item.uploadedAt.getTime() < cutoff).map(item => item.path);
  if (expired.length) await storage.remove(expired);
  return { path, revision };
}

export async function backupStatus(owner: string, key: Buffer, storage: Pick<typeof privateBlobStorage, 'read' | 'list'> = privateBlobStorage): Promise<{ savedAt: string; revision: string } | null> {
  const prefix = ownerPrefix(owner, key);
  const items = (await storage.list(prefix)).filter(item => isArchive(item.path, prefix) && Number.isFinite(item.uploadedAt.getTime()));
  items.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  if (!items.length) return null;
  const archive = decryptArchive(await storage.read(items[0].path), key);
  const revision = archive.rows.coinjar_journals[0].revision;
  if (archive.owner !== owner || typeof revision !== 'string' || !/^\d+$/.test(revision)) throw new Error('Invalid backup');
  return { savedAt: items[0].uploadedAt.toISOString(), revision };
}
