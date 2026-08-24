import { getAddressStats } from "../chain/addressStats.js";

export async function handleAddressStats(deps, params) {
  const address = params?.address;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("params.address (string) is required");
  }
  return getAddressStats(deps, address);
}
