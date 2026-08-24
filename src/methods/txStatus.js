import { getTxStatus } from "../chain/txStatus.js";

const TXID_RE = /^[0-9a-fA-F]{64}$/;

export async function handleTxStatus(deps, params) {
  const txid = params?.txid;
  if (typeof txid !== "string" || !TXID_RE.test(txid)) {
    throw new Error("params.txid (64-char hex string) is required");
  }
  return getTxStatus(deps, txid);
}
