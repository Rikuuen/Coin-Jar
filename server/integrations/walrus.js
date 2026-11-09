/** @param {{ key?: string, accountId?: string, serverUrl?: string, namespace?: string, client?: any }} options */
export async function createMemoryAdapter({
  key,
  accountId,
  serverUrl,
  namespace = 'coinjar-v1',
  client,
} = {}) {
  if (!client) {
    if (!key || !accountId) throw new Error('Walrus Memory is not configured');
    const { MemWal } = await import('@mysten-incubation/memwal');
    client = MemWal.create({ key, accountId, serverUrl, namespace });
  }
  return {
    remember: (text, options) => options ? client.rememberAndWait(text, namespace, options) : client.rememberAndWait(text, namespace),
    search: (query, limit = 10, options = {}) => client.recall({ query, namespace, limit, ...options }),
    list: (options = {}) => client.listMemories({ ...options, namespace }),
  };
}
