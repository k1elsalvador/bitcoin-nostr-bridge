import { addressToScripthash } from "../fulcrum.js";

/**
 * mempool.space-shaped UTXO array. Throws if the address has more than
 * maxPerResponse UTXOs rather than silently returning a partial (and
 * therefore wrong-looking, since callers sum `value` for balance) list — an
 * explicit error is safer than a truncated set that still reports ok:true.
 * See docs/BRIDGE-CONTRACT.md for the pagination TODO if this is ever hit by
 * a real wallet address.
 */
export async function getAddressUtxos({ fulcrum, bitcoinRpc, network, maxPerResponse }, address) {
  const scripthash = addressToScripthash(address, network);
  const utxos = await fulcrum.listUnspent(scripthash); // [{tx_hash, tx_pos, height, value}]
  if (utxos.length > maxPerResponse) {
    throw new Error(
      `Address has ${utxos.length} UTXOs, more than this bridge can return in one response ` +
        `(limit ${maxPerResponse}) — pagination isn't implemented yet`,
    );
  }

  const heights = [...new Set(utxos.filter((u) => u.height > 0).map((u) => u.height))];
  const hashByHeight = new Map(
    await Promise.all(heights.map(async (h) => [h, await bitcoinRpc.getBlockHash(h)])),
  );

  return utxos.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    value: u.value,
    status:
      u.height > 0
        ? { confirmed: true, block_height: u.height, block_hash: hashByHeight.get(u.height) }
        : { confirmed: false },
  }));
}
