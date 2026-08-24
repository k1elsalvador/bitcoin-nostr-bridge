export async function broadcastTx({ bitcoinRpc }, rawHex) {
  const txid = await bitcoinRpc.sendRawTransaction(rawHex);
  return { txid };
}
