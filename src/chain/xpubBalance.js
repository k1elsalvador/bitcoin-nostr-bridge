import { parseExtendedPubkey } from "./xpubKeys.js";
import { getAddressStats } from "./addressStats.js";
import { getAddressUtxos } from "./addressUtxo.js";
import { addressToScripthash } from "../fulcrum.js";

// Hard backstop on how deep a single chain (external/internal) is walked,
// independent of gapLimit — guarantees termination even if gapLimit is
// misconfigured; real HD wallets never come close to this.
const MAX_INDEX_PER_CHAIN = 2000;

/**
 * BIP44/49/84 gap-limit scan across an xpub/ypub/zpub's external (0) and
 * internal/change (1) chains, aggregating chain.address.stats/utxo results
 * (reused as-is per derived address) into one combined summary. Mirrors what
 * OnChainPayoutManager.scanUtxos() does today, just run once locally instead
 * of address-by-address over a rate-limited public API.
 */
export async function getXpubBalance(deps, xpubStr, gapLimit) {
  const { fulcrum, network, maxHistoryTxs, maxPerResponse, maxAddresses } = deps;
  const { deriveAddress } = parseExtendedPubkey(xpubStr, network);

  // Tracks whether the scan actually reached its natural end (gapLimit
  // consecutive unused addresses on both chains) rather than being cut off
  // by a safety cap — a caller summing chain_stats/utxos for a balance needs
  // to know if the result might be missing a still-used tail past the cap,
  // not just get a plausible-looking-but-possibly-incomplete number.
  let complete = true;

  const usedAddresses = []; // [{address, path}]
  outer: for (const chainIndex of [0, 1]) {
    let consecutiveUnused = 0;
    let index = 0;
    while (consecutiveUnused < gapLimit) {
      if (usedAddresses.length >= maxAddresses) {
        complete = false;
        break outer;
      }
      if (index >= MAX_INDEX_PER_CHAIN) {
        complete = false;
        break;
      }
      const { address, path } = deriveAddress(chainIndex, index);
      const history = await fulcrum.getHistory(addressToScripthash(address, network));
      if (history.length > 0) {
        usedAddresses.push({ address, path });
        consecutiveUnused = 0;
      } else {
        consecutiveUnused += 1;
      }
      index += 1;
    }
  }

  const chain_stats = { funded_txo_count: 0, spent_txo_count: 0, tx_count: 0 };
  const mempool_stats = { funded_txo_count: 0, spent_txo_count: 0, tx_count: 0 };
  const utxos = [];

  for (const { address, path } of usedAddresses) {
    const stats = await getAddressStats({ fulcrum, network, maxHistoryTxs }, address);
    chain_stats.funded_txo_count += stats.chain_stats.funded_txo_count;
    chain_stats.spent_txo_count += stats.chain_stats.spent_txo_count;
    chain_stats.tx_count += stats.chain_stats.tx_count;
    mempool_stats.funded_txo_count += stats.mempool_stats.funded_txo_count;
    mempool_stats.spent_txo_count += stats.mempool_stats.spent_txo_count;
    mempool_stats.tx_count += stats.mempool_stats.tx_count;

    const addrUtxos = await getAddressUtxos(
      { fulcrum, bitcoinRpc: deps.bitcoinRpc, network, maxPerResponse },
      address,
    );
    for (const u of addrUtxos) utxos.push({ ...u, address, path });
  }

  return {
    xpub: xpubStr,
    gapLimit,
    addressesScanned: usedAddresses.length,
    complete,
    chain_stats,
    mempool_stats,
    utxos,
  };
}
