import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";

export function decodeNsec(nsec) {
  if (!nsec?.startsWith("nsec1")) {
    throw new Error(
      "config.json's identity.nsec is not a valid nsec — generate one with " +
        "`node tools/generate-identity.js` and paste it in.",
    );
  }
  let decoded;
  try {
    decoded = nip19.decode(nsec);
  } catch (err) {
    throw new Error(`config.json's identity.nsec failed to decode: ${err.message}`);
  }
  if (decoded.type !== "nsec") {
    throw new Error(`Expected nsec, got ${decoded.type}`);
  }
  return decoded.data;
}

export function deriveIdentity(nsec) {
  const secretKey = decodeNsec(nsec);
  const pubkeyHex = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkeyHex);
  return { secretKey, pubkeyHex, npub };
}

/**
 * Accepts either an npub or a raw 64-char hex pubkey and returns hex.
 * Used for config-supplied pubkeys (trustedPubkeys) where either form is convenient.
 */
export function normalizePubkey(value) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }
  const decoded = nip19.decode(value);
  if (decoded.type !== "npub") {
    throw new Error(`Expected npub or 64-char hex pubkey, got: ${value}`);
  }
  return decoded.data;
}
