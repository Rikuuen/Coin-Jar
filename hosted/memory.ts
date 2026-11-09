import { createHmac } from 'node:crypto';

export function hostedMemoryNamespace(secret: string, owner: string) {
  if (secret.length < 32 || !owner) throw new Error('A stable Walrus namespace secret of at least 32 characters is required');
  return `coinjar-hosted-${createHmac('sha256', secret).update(owner).digest('hex')}`;
}

export function memoryPreferences(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid memory');
  const p = value as Record<string, unknown>;
  if (p.currency !== 'PHP' || !Number.isSafeInteger(p.bufferCents) || Number(p.bufferCents) < 0 || Number(p.bufferCents) > 10_000_000_000 || !Number.isSafeInteger(p.dailyLimitCents) || Number(p.dailyLimitCents) < 0 || Number(p.dailyLimitCents) > 10_000_000_000 || !['gentle', 'steady', 'focused'].includes(String(p.pace)) || (p.confirmedWeekend !== undefined && typeof p.confirmedWeekend !== 'boolean')) throw new Error('Invalid memory');
  const source = p.limitProvenance && typeof p.limitProvenance === 'object' ? p.limitProvenance as Record<string, unknown> : {};
  const origin = ['manual', 'confirmed', 'explicit'].includes(String(source.origin)) ? source.origin : 'unknown';
  // Only aggregate weekend evidence is allowed; per-transaction observations remain in Neon.
  const observations = Array.isArray(source.observations) ? source.observations.filter((item): item is string => typeof item === 'string' && /^\d{1,3} weekend days and \d{1,3} weekdays with recorded expenses in the last 56 days; days without recorded expenses are excluded\.$/.test(item)).slice(0, 1) : [];
  const manualOrigin = (input: unknown) => input && typeof input === 'object' && (input as Record<string, unknown>).origin === 'manual' ? 'manual' : 'unknown';
  return { currency: 'PHP', bufferCents: p.bufferCents, dailyLimitCents: p.dailyLimitCents, pace: p.pace, confirmedWeekend: p.confirmedWeekend === true, limitProvenance: { origin, ...(observations.length ? { observations } : {}) }, bufferProvenance: { origin: manualOrigin(p.bufferProvenance) }, paceProvenance: { origin: manualOrigin(p.paceProvenance) } };
}

export function memoryRows(value: unknown) {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (Number(data.dropped_count ?? 0) > 0) throw new Error('Memory recall is incomplete');
  const rows = Array.isArray(value) ? value : (data.memories ?? data.results ?? data.matches);
  if (!Array.isArray(rows)) throw new Error('Invalid memory response');
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const id = String(item.blob_id ?? item.blobId ?? item.id ?? '');
    const text = String(item.text ?? item.content ?? '');
    if (!id || id.length > 256 || !text.startsWith('COINJAR_HOSTED_V1 ') || text.length > 4000) return [];
    try {
      const value = JSON.parse(text.slice('COINJAR_HOSTED_V1 '.length));
      if (!['preferences', 'correction', 'insight'].includes(value.kind) || typeof value.text !== 'string' || value.text.length > 1000) return [];
      if (value.kind !== 'preferences' || value.text !== '') return [];
      return [{ id, kind: 'preferences', text: '', preferences: memoryPreferences(value.preferences) }];
    } catch { return []; }
  });
}
