import React, { useMemo, useState } from 'react';
import { createDAppKit, DAppKitProvider, useCurrentAccount, useDAppKit, useWallets } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

type Props = { network: 'mainnet' | 'testnet'; post: (path: string, body: Record<string, unknown>) => Promise<any>; onVerified: (address: string) => void; onError: (text: string) => void };

export default function WalletConnect(props: Props) {
  if (!window.isSecureContext) return <p className="welcome-note">Wallet connection needs HTTPS. You can explore this local preview without connecting.</p>;
  return <SecureConnect {...props} />;
}

function SecureConnect(props: Props) {
  const kit = useMemo(() => createDAppKit({ networks: [props.network], defaultNetwork: props.network, autoConnect: false, enableBurnerWallet: false, slushWalletConfig: { appName: 'CoinJar' }, createClient: (network) => new SuiGrpcClient({ network, baseUrl: `https://fullnode.${network}.sui.io:443` }) }), [props.network]);
  return <DAppKitProvider dAppKit={kit}><Connect {...props} /></DAppKitProvider>;
}

function Connect({ post, onVerified, onError }: Props) {
  const kit = useDAppKit(), account = useCurrentAccount(), wallets = useWallets();
  const [working, setWorking] = useState(false);
  const slush = wallets.find((wallet) => wallet.name.toLowerCase().includes('slush'));
  const verify = async () => {
    if (!account) return;
    setWorking(true);
    try {
      const challenge = await post('/api/simple/wallet/challenge', { address: account.address });
      if (!challenge) return;
      const signed = await kit.signPersonalMessage({ message: new TextEncoder().encode(challenge.message) });
      const result = await post('/api/simple/wallet/verify', { id: challenge.id, signature: signed.signature });
      if (result?.address) onVerified(result.address);
    } catch { onError('Wallet verification was not completed.'); }
    finally { setWorking(false); }
  };
  if (account) return <div className="welcome-wallet"><p>Connected: {account.address.slice(0, 8)}…{account.address.slice(-6)}</p><button type="button" className="simple-button primary" disabled={working} onClick={() => void verify()}>{working ? 'Waiting for wallet…' : 'Verify in Slush'}</button></div>;
  return <button type="button" className="simple-button primary welcome-primary" disabled={!slush || working} onClick={() => { if (!slush) return; setWorking(true); void kit.connectWallet({ wallet: slush }).catch(() => onError('Wallet connection was not completed.')).finally(() => setWorking(false)); }}>{slush ? 'Connect Slush' : 'Slush wallet unavailable'}</button>;
}
