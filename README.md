# CoinJar

CoinJar is a phone-first savings journal. Set a currency and balance, record income and expenses, and choose a savings goal and target date. CoinJar suggests a daily amount and adjusts the pace as the goal progresses.

The journal stays in the browser. Optional Walrus Memory stores approved preferences and spending patterns on mainnet, and encrypted journal recovery lets you restore a saved snapshot using your recovery key. Encrypted backups start automatically once the separate recovery key is saved and confirmed. Link a public Sui address in Profile; read-only Tatum balance checks on the goal show SUI and changes since the previous check separately from recorded savings. A wallet change is not proof of a contribution, and a savings entry is not a bank transfer.

The plain app URL opens the journal previously accessed through the longer mainnet URL. The former plain-link journal is not shown or deleted. Older recovery and personal memory namespaces remain accessible.

Activity entries can be corrected without deleting the original. Corrected originals remain visible but do not count in totals, goal progress, or spending patterns. The optional 8 PM reminder appears only while CoinJar is open and uses the device's local time. It does not send background notifications; reminder settings are stored on that device.

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

Tests use fixtures and do not prove live provider availability. Wallet checks are user initiated, and prior balance readings are kept on the device, not in the encrypted journal backup. Automatic backup runs while CoinJar is open and retries after reconnecting. It pauses when an existing remote backup differs from the last known snapshot; the user can restore it or explicitly choose this device's journal. Separate devices do not have an atomic conflict lock, so avoid editing them simultaneously. Walrus recovery requires the saved recovery key and a successfully saved backup. Walrus storage may expire, and the experimental recovery is not a guaranteed replacement for a database. Clearing browser data can remove the local journal. This project is not a verified PayBox marketplace plugin.
