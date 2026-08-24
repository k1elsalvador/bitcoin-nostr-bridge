import { getXpubBalance } from "../chain/xpubBalance.js";

const XPUB_PREFIX_RE = /^[xyztuv]pub/i;

export async function handleXpubBalance(deps, params) {
  const xpub = params?.xpub;
  if (typeof xpub !== "string" || !XPUB_PREFIX_RE.test(xpub)) {
    throw new Error("params.xpub (xpub/ypub/zpub string) is required");
  }

  let gapLimit = deps.xpubGapLimit;
  if (params?.gapLimit !== undefined) {
    const requested = Number(params.gapLimit);
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error("params.gapLimit must be a positive integer");
    }
    gapLimit = Math.min(requested, deps.xpubMaxGapLimit);
  }

  return getXpubBalance(deps, xpub, gapLimit);
}
