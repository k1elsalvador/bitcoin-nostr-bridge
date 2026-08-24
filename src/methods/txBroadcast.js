import { broadcastTx } from "../chain/txBroadcast.js";

const HEX_RE = /^[0-9a-fA-F]+$/;

export async function handleTxBroadcast(deps, params) {
  const rawHex = params?.rawHex;
  if (typeof rawHex !== "string" || rawHex.length === 0 || !HEX_RE.test(rawHex)) {
    throw new Error("params.rawHex (hex string) is required");
  }
  return broadcastTx(deps, rawHex);
}
