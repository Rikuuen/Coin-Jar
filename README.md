# CoinJar

CoinJar is a local, single-user savings journal for tracking balances, income, expenses, and savings goals. It can optionally use Walrus Memory for consented summaries and Tatum for exchange rates and Sui balance lookups. A journal entry or movement into the in-app jar is bookkeeping, not a bank transfer.

## Run locally

Requires Node.js 24 or later.

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4318. For an isolated sample journal, run `npm run demo` and open http://127.0.0.1:4320. The demo uses a separate local database. Copy `.env.example` to `.env` and fill in optional integration settings only if needed. Never commit `.env`, keys, wallet recovery phrases, databases, or certificates.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

The browser tests use Chrome and a separate local test database. Build the application before running them.

## Limits

The app runs locally and is not a hosted multi-user service. It is not a bank connection or an independently verified PayBox marketplace plugin. Wallet-approved Sui USDC transfers require a separate user approval and network fees; a recorded journal contribution alone does not prove a transfer. Optional Walrus summaries are processed by the memory service as plaintext. zkLogin wallet verification sends the signed challenge and wallet address to the configured public Sui verification service.
