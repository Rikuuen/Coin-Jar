import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateDatabaseUrl, validateHostedBuild } from '../hosted/config';

test('hosted database configuration requires certificate and hostname verification', () => {
  assert.doesNotThrow(() => validateDatabaseUrl('postgresql://user:password@db.example.test/app?sslmode=verify-full'));
  for (const value of ['postgres://user:password@db.example.test/app', 'postgres://db.example.test/app?sslmode=require', 'postgres://db.example.test/app?sslmode=verify-full&sslmode=disable', 'https://db.example.test/app?sslmode=verify-full', 'not a url']) {
    assert.throws(() => validateDatabaseUrl(value));
  }
});

test('hosted server rejects builds without the tracking-only marker', () => {
  assert.doesNotThrow(() => validateHostedBuild('<meta name="coinjar-hosted-build" content="true" />'));
  assert.throws(() => validateHostedBuild('<meta name="coinjar-hosted-build" content="false" />'));
  assert.throws(() => validateHostedBuild(''));
});
