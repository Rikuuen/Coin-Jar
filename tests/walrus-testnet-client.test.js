import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { registerTestClient } from '../experiments/walrus-testnet-client.mjs';

test('Walrus registration check targets testnet with only the public CoinJar callback', async () => {
  const result = await registerTestClient(async (url, options) => {
    assert.equal(url, 'https://relayer.dev.memwal.ai/oauth/register');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.redirect_uris, ['https://coinjar-personal-preview.vercel.app/walrus/callback']);
    assert.equal(body.token_endpoint_auth_method, 'none');
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_redirect_uri', client_secret: 'must-not-be-returned' }) };
  });
  assert.deepEqual(result, { status: 400, registered: false, error: 'invalid_redirect_uri' });
});
