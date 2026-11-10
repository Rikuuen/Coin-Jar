import React, { useMemo, useState } from 'react';
import { createDAppKit, DAppKitProvider, useCurrentAccount, useDAppKit, useWallets } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { type AppState, type OnchainTransfer } from './domain';
import { estimateGas, formatSui } from './sui';
import { makeUsdcTransfer, parseUsdc, formatUsdc } from './usdc';

type Props = { state: AppState; network: 'mainnet' | 'testnet'; suggestedUsdc?: string; quoteTimestamp?: number; busy: boolean; post: (path: string, body: unknown) => Promise<any>; onError: (message: string) => void };

export default function WalletTransfer(props: Props) {
  const kit = useMemo(() => createDAppKit({
    networks: [props.network], defaultNetwork: props.network, autoConnect: false, enableBurnerWallet: false,
    slushWalletConfig: { appName: 'CoinJar' },
    createClient: (network) => new SuiGrpcClient({ network, baseUrl: `https://fullnode.${network}.sui.io:443` }),
  }), [props.network]);
  if (!window.isSecureContext) return <p>Wallet transactions require a secure connection. The local phone preview is not suitable for wallet use.</p>;
  return <DAppKitProvider dAppKit={kit}><TransferForm {...props} /></DAppKitProvider>;
}

function TransferForm({ state, network, suggestedUsdc, quoteTimestamp, busy, post, onError }: Props) {
  const kit = useDAppKit();
  const wallets = useWallets();
  const account = useCurrentAccount();
  const [amount, setAmount] = useState('');
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<{ id: string; sender: string; recipient: string; amount: string; gas: string; budget: string; at: number }>();
  const recipient = state.goal?.wallet?.address;
  const active = state.onchainTransfers?.find((item) => ['awaiting_wallet', 'unknown', 'pending'].includes(item.status));
  const previewTransfer = async () => {
    setPreview(undefined);
    if (!account || !recipient) return;
    setWorking(true);
    let intentId: string | undefined;
    try {
      const units = parseUsdc(amount);
      if (account.address.toLowerCase() === recipient.toLowerCase()) throw new Error('Choose a savings address different from your connected wallet.');
      const created = await post('/api/onchain/intent', { sender: account.address, recipient, amountMicroUsdc: units, network });
      const intent = created?.state.onchainTransfers?.find((item: OnchainTransfer) => item.status === 'awaiting_wallet');
      if (!intent) return;
      intentId = intent.id;
      const tx = makeUsdcTransfer(account.address, recipient, units, intentId!, network);
      const result = await kit.getClient().core.simulateTransaction({ transaction: tx, include: { effects: true } });
      if (result.$kind !== 'Transaction' || !result.Transaction.effects || result.gasPaymentMocked) throw new Error('Could not estimate fees with the connected wallet’s funds.');
      const quote = estimateGas(result.Transaction.effects.gasUsed);
      setPreview({ id: intentId!, sender: account.address, recipient, amount: units, gas: quote.fee, budget: quote.budget, at: Date.now() });
    } catch (error) {
      if (intentId) await post('/api/onchain/dismiss', { id: intentId, acknowledged: true });
      onError(error instanceof Error ? error.message : 'Could not estimate this transfer.');
    }
    finally { setWorking(false); }
  };
  const submit = async () => {
    if (!preview || !account || !recipient || active?.id !== preview.id || active.status !== 'awaiting_wallet' || busy || working || preview.sender !== account.address || preview.recipient !== recipient || Date.now() - preview.at > 60000) { setPreview(undefined); onError('Review the current wallet, amount and fee again.'); return; }
    setWorking(true);
    const intentId = preview.id;
    try {
      if (parseUsdc(amount) !== preview.amount) throw new Error('Amount changed.');
      const current = kit.stores.$connection.get();
      if (!current.account || current.account.address !== preview.sender) {
        await post('/api/onchain/dismiss', { id: intentId, acknowledged: true });
        setPreview(undefined);
        onError('The connected account changed before approval. Review the transfer again.');
        return;
      }
      const marked = await post('/api/onchain/unknown', { id: intentId });
      if (!marked) throw new Error('Could not persist the pending transfer.');
      const result = await kit.signAndExecuteTransaction({ transaction: makeUsdcTransfer(preview.sender, preview.recipient, preview.amount, intentId, network, preview.budget) });
      const tx = result.Transaction ?? result.FailedTransaction;
      if (!tx?.digest) throw new Error('The wallet did not return a transaction digest.');
      const recorded = await post('/api/onchain/digest', { id: intentId, digest: tx.digest });
      if (!recorded) { onError(`Save this digest and check your wallet before doing anything else: ${tx.digest}`); return; }
      await post('/api/onchain/verify', { id: intentId });
      setPreview(undefined);
    } catch {
      await post('/api/onchain/unknown', { id: intentId });
      onError('Wallet outcome is uncertain. Check your wallet and transaction history before trying again.');
    } finally { setWorking(false); }
  };
  return <div className="wallet-transfer">
    <h3>Optional USDC transfer on Sui</h3>
    <p>This sends {network === 'testnet' ? 'test DUSDC with no real value' : 'native USDC'} from your connected wallet to the saved Sui address. Network fees may require SUI. It does not convert pesos. Only send to an address you trust; CoinJar cannot prove who controls it. Never enter a recovery phrase or private key in CoinJar.</p>
    {!account ? <div><p>Connect a compatible wallet to continue.</p>{wallets.map((wallet) => <button className="button outline" key={wallet.name} disabled={busy || working} onClick={() => void kit.connectWallet({ wallet }).catch(() => onError('Wallet connection was not completed.'))}>Connect {wallet.name}</button>)}{!wallets.length && <p>No supported wallet is available in this browser.</p>}</div> : <p>Connected: {account.address} <button className="text-button" onClick={() => void kit.disconnectWallet()}>Disconnect</button></p>}
    {!recipient && <p>Add a savings address in Settings before transferring.</p>}
    {active && (!preview || preview.id !== active.id || active.status !== 'awaiting_wallet') ? <div className="pending-transfer"><p>A transfer is {active.status.replace('_', ' ')}. Do not send again until you check your wallet history.</p><p>{active.asset === 'USDC' ? `${formatUsdc(active.amountMicroUsdc!)} ${active.network === 'testnet' ? 'DUSDC' : 'USDC'}` : `${formatSui(active.amountMist!)} SUI`} to {active.recipient} · {active.network}</p>
      <form onSubmit={(event) => { event.preventDefault(); const digest = String(new FormData(event.currentTarget).get('digest')); if (active.digest && digest !== active.digest && !window.confirm('Have you checked the wallet and confirmed this is the correct digest? Replacing it does not cancel any transaction.')) return; void post('/api/onchain/digest', { id: active.id, digest, ...(active.digest && digest !== active.digest ? { replace: true, acknowledged: true } : {}) }); }}><label>Transaction digest from your wallet<input name="digest" required defaultValue={active.digest ?? ''} /></label><button className="button outline" disabled={busy || working}>{active.digest ? 'Correct digest' : 'Save digest'}</button></form>
      {active.digest && <><p>Digest: {active.digest}</p><button className="button outline" disabled={busy || working} onClick={() => void post('/api/onchain/verify', { id: active.id })}>Check transaction</button></>}
      <button className="text-button" disabled={busy || working} onClick={() => { if (window.confirm('Have you checked your wallet? Dismissing this record does not cancel or reverse a transaction.')) void post('/api/onchain/dismiss', { id: active.id, acknowledged: true }); }}>Dismiss after checking wallet</button>
    </div> : <>
      <label>Amount in {network === 'testnet' ? 'test DUSDC' : 'USDC'}<input value={amount} disabled={busy || working} onChange={(event) => { setAmount(event.target.value); setPreview(undefined); }} inputMode="decimal" placeholder="0.00" /></label>
      {suggestedUsdc && <button className="button outline" disabled={busy || working} onClick={() => { if (!quoteTimestamp || quoteTimestamp > Date.now() || Date.now() - quoteTimestamp > 86400000) { onError('The exchange-rate estimate is out of date. Refresh before using it.'); return; } setAmount(suggestedUsdc); setPreview(undefined); }}>Use suggested amount: {suggestedUsdc} {network === 'testnet' ? 'test DUSDC' : 'USDC'}</button>}
      {!preview && <button className="button outline" disabled={!account || !recipient || busy || working} onClick={() => void previewTransfer()}>Review amount and estimated network fee</button>}
      {preview && <div className="transfer-review"><p>Send <strong>{formatUsdc(preview.amount)} {network === 'testnet' ? 'test DUSDC' : 'USDC'}</strong> on Sui {network} to <strong>{preview.recipient}</strong>.</p><p>Estimated network fee: {formatSui(preview.gas)} SUI. Maximum gas budget: {formatSui(preview.budget)} SUI. Check the wallet’s confirmation before approving; the estimate expires after one minute.</p><p>After verification, a USD/PHP reference may be used to estimate goal progress assuming 1 USDC = $1. Never manually record the same transfer as well.</p><button className="button primary" disabled={busy || working} onClick={() => void submit()}>Approve in wallet</button><button className="text-button" disabled={busy || working} onClick={() => void post('/api/onchain/dismiss', { id: preview.id, acknowledged: true }).then((result) => { if (result) setPreview(undefined); })}>Cancel review</button></div>}
    </>}
  </div>;
}
