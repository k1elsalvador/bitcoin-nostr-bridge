export async function getTxStatus({ bitcoinRpc }, txid) {
  let tx;
  try {
    tx = await bitcoinRpc.getRawTransaction(txid, true);
  } catch (err) {
    if (/No such mempool or blockchain transaction/i.test(err.message)) {
      throw new Error("Transaction not found");
    }
    throw err;
  }

  if (!tx.blockhash) {
    return { txid, status: { confirmed: false } };
  }

  const header = await bitcoinRpc.getBlockHeader(tx.blockhash);
  return {
    txid,
    status: { confirmed: true, block_height: header.height, block_hash: tx.blockhash },
  };
}
