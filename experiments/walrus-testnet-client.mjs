import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function registerTestClient(request = fetch) {
  const response = await request('https://relayer.dev.memwal.ai/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'CoinJar phone testnet', redirect_uris: ['https://coinjar-personal-preview.vercel.app/walrus/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  });
  const result = await response.json();
  return { status: response.status, registered: response.ok && typeof result.client_id === 'string', error: typeof result.error === 'string' ? result.error : null, ...(typeof result.error_description === 'string' ? { description: result.error_description.slice(0, 500) } : {}), ...(response.ok && result.token_endpoint_auth_method === 'none' && typeof result.client_id === 'string' ? { clientId: result.client_id } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await registerTestClient()));
