/** @param {{ apiKey?: string, network?: string, client?: any }} options */
export async function createTatumAdapter({
  apiKey,
  network = 'testnet',
  client,
} = {}) {
  if (!['mainnet', 'testnet'].includes(network))
    throw new Error('Unsupported Sui network');
  if (!client) {
    if (!apiKey) throw new Error('Tatum is not configured');
    const [{ SuiGrpcClient }, { GrpcTransport }, { ChannelCredentials }] =
      await Promise.all([
        import('@mysten/sui/grpc'),
        import('@protobuf-ts/grpc-transport'),
        import('@grpc/grpc-js'),
      ]);
    const transport = new GrpcTransport({
      host: `sui-${network}-grpc.gateway.tatum.io:443`,
      channelCredentials: ChannelCredentials.createSsl(),
      meta: { 'x-api-key': apiKey },
      timeout: 10000,
    });
    client = new SuiGrpcClient({ network, transport });
  }
  return {
    async getBalance(address, coinType = '0x2::sui::SUI') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(address))
        throw new Error('Invalid Sui address');
      const { balance } = await client.getBalance({
        owner: address,
        coinType,
      });
      if (
        typeof balance?.balance !== 'string' ||
        !/^\d+$/.test(balance.balance)
      )
        throw new Error('Invalid balance response');
      return {
        network,
        coinType,
        balanceMist: balance.balance,
      };
    },
    async getTransaction(digest) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(digest)) throw new Error('Invalid transaction digest');
      const result = await client.getTransaction({ digest, include: { effects: true, transaction: true, balanceChanges: true } });
      const transaction = result.Transaction ?? result.FailedTransaction;
      if (!transaction || transaction.digest !== digest) throw new Error('Invalid transaction response');
      return { network, digest: transaction.digest, success: transaction.status?.error?.$kind === 'Unknown' ? null : transaction.status?.success, checkpoint: transaction.checkpoint, timestampMs: transaction.timestampMs, sender: transaction.transaction?.sender, inputs: transaction.transaction?.inputs, balanceChanges: transaction.balanceChanges };
    },
  };
}
