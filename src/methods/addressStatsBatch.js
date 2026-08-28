import { getAddressStats } from "../chain/addressStats.js";

export async function handleAddressStatsBatch(deps, params) {
  const addresses = params?.addresses;
  if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((a) => typeof a === "string")) {
    throw new Error(
      `params.addresses (non-empty array of address strings, max ${deps.maxBatchAddresses}) is required`,
    );
  }
  if (addresses.length > deps.maxBatchAddresses) {
    throw new Error(`params.addresses exceeds the limit of ${deps.maxBatchAddresses} addresses per batch`);
  }

  return Promise.all(
    addresses.map(async (address) => {
      try {
        const stats = await getAddressStats(deps, address);
        return { address, ok: true, chain_stats: stats.chain_stats, mempool_stats: stats.mempool_stats };
      } catch (err) {
        return { address, ok: false, error: err.message };
      }
    }),
  );
}
