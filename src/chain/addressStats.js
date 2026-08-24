import { addressToScripthash, scriptToScripthash } from "../fulcrum.js";

/**
 * Esplora-style {chain_stats, mempool_stats} derived from Electrum protocol's
 * scripthash history, which only gives us tx_hash/height per touching tx —
 * funded/spent counts have to be computed by walking each tx's vout/vin.
 */
export async function getAddressStats({ fulcrum, network, maxHistoryTxs = 500 }, address) {
  const scripthash = addressToScripthash(address, network);
  const history = await fulcrum.getHistory(scripthash); // [{tx_hash, height}]

  const chain = { funded_txo_count: 0, spent_txo_count: 0, tx_count: 0 };
  const mempool = { funded_txo_count: 0, spent_txo_count: 0, tx_count: 0 };
  const bucketFor = (height) => (height > 0 ? chain : mempool);

  if (history.length === 0) {
    return { address, chain_stats: chain, mempool_stats: mempool };
  }

  // A single Query is a full history walk (one tx fetch per touching tx) —
  // fine for a real wallet address, but an open bridge could otherwise be
  // pointed at a famous, heavily-reused address and asked to fetch tens of
  // thousands of transactions serially. Refuse rather than hang.
  if (history.length > maxHistoryTxs) {
    throw new Error(
      `Address history too large to summarize (${history.length} transactions, limit ${maxHistoryTxs})`,
    );
  }

  for (const h of history) {
    bucketFor(h.height).tx_count += 1;
  }

  const txByTxid = new Map(
    await Promise.all(history.map(async (h) => [h.tx_hash, await fulcrum.getTransaction(h.tx_hash, true)])),
  );

  // Pass 1: find our own outputs among all txs touching this address.
  // "txid:vout" -> the height bucket the funding tx belongs to.
  const fundedOutpoints = new Map();
  for (const h of history) {
    const tx = txByTxid.get(h.tx_hash);
    tx.vout.forEach((out, i) => {
      if (out.scriptPubKey?.hex && scriptToScripthash(out.scriptPubKey.hex) === scripthash) {
        fundedOutpoints.set(`${h.tx_hash}:${i}`, h.height);
      }
    });
  }

  // Pass 2: any input spending one of our own outpoints is a spend, bucketed
  // by the *spending* tx's height.
  for (const h of history) {
    const tx = txByTxid.get(h.tx_hash);
    for (const vin of tx.vin) {
      if (vin.coinbase) continue;
      if (fundedOutpoints.has(`${vin.txid}:${vin.vout}`)) {
        bucketFor(h.height).spent_txo_count += 1;
      }
    }
  }

  for (const fundHeight of fundedOutpoints.values()) {
    bucketFor(fundHeight).funded_txo_count += 1;
  }

  return { address, chain_stats: chain, mempool_stats: mempool };
}
