# CoinJar

CoinJar is a phone-first savings journal. Set a currency and balance, record income and expenses, and choose a savings goal and target date. CoinJar suggests a daily amount and adjusts the pace as the goal progresses.

The journal stays in the browser. Optional Walrus Memory stores approved preferences and spending patterns, and encrypted journal recovery lets you restore a saved snapshot using your recovery key. Automatic encrypted backups can be enabled after saving the separate recovery key. A read-only Tatum lookup shows a Sui wallet balance separately from recorded savings. A savings entry is not a bank transfer.

## Run the phone app

Requires Node.js 24 or later.

```sh
npm ci
node scripts/build-phone.mjs
node phone-server.mjs
```

Open http://127.0.0.1:4371. Walrus and Tatum require server-side provider configuration. Keep credentials in environment variables and never commit keys, recovery codes, or journal data.

## Checks

```sh
npm run typecheck
npm test
node scripts/build-phone.mjs
npx playwright test --config playwright-phone.config.ts
```

Tests use fixtures and do not prove live provider availability. Automatic backup runs while CoinJar is open and retries after reconnecting. It pauses when an existing remote backup differs from the last known snapshot; the user can restore it or explicitly choose this device's journal. Separate devices do not have an atomic conflict lock, so avoid editing them simultaneously. Walrus recovery requires the saved recovery key and a successfully saved backup. Walrus storage may expire, and the experimental recovery is not a guaranteed replacement for a database. Clearing browser data can remove the local journal. This project is not a verified PayBox marketplace plugin.
