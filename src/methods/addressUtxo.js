import { getAddressUtxos } from "../chain/addressUtxo.js";

export async function handleAddressUtxo(deps, params) {
  const address = params?.address;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("params.address (string) is required");
  }
  return getAddressUtxos(deps, address);
}
