import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { deriveIdentity, normalizePubkey } from "./identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function required(obj, keyPath) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur == null || !(part in cur)) {
      throw new Error(`config.json is missing required field: ${keyPath}`);
    }
    cur = cur[part];
  }
  return cur;
}

export function loadConfig(configPath = path.join(__dirname, "..", "config.json")) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read ${configPath} — copy config.example.json to config.json and fill it in. (${err.message})`,
    );
  }

  const cfg = JSON.parse(raw);

  required(cfg, "relays");
  if (!Array.isArray(cfg.relays) || cfg.relays.length === 0) {
    throw new Error("config.json: relays must be a non-empty array of relay URLs");
  }

  const nsec = required(cfg, "identity.nsec");
  const identity = deriveIdentity(nsec);

  // Default to allowlist (trust nobody until configured) — safer out-of-the-box for a new
  // self-hosted deployment than answering any requester. Explicitly set "open" in config.json
  // if that's a deliberate choice for your deployment.
  const trustMode = cfg.trust?.mode ?? "allowlist";
  if (trustMode !== "open" && trustMode !== "allowlist") {
    throw new Error(`config.json: trust.mode must be "open" or "allowlist", got: ${trustMode}`);
  }
  const trustedPubkeys = new Set(
    (cfg.trust?.trustedPubkeys ?? []).map((pk) => normalizePubkey(pk)),
  );

  const kindQuery = cfg.kinds?.query ?? 3920;
  const kindReply = cfg.kinds?.reply ?? 3921;

  return {
    network: cfg.network ?? "bitcoin",
    relays: cfg.relays,
    identity,
    trust: { mode: trustMode, trustedPubkeys },
    kinds: { query: kindQuery, reply: kindReply },
    expirationSeconds: cfg.expirationSeconds ?? 900,
    fulcrum: {
      host: required(cfg, "fulcrum.host"),
      port: required(cfg, "fulcrum.port"),
      tls: cfg.fulcrum?.tls ?? true,
      tlsRejectUnauthorized: cfg.fulcrum?.tlsRejectUnauthorized ?? true,
    },
    bitcoinCore: {
      host: required(cfg, "bitcoinCore.host"),
      port: required(cfg, "bitcoinCore.port"),
      user: required(cfg, "bitcoinCore.user"),
      password: required(cfg, "bitcoinCore.password"),
    },
    fee: {
      confTargets: cfg.fee?.confTargets ?? {
        fastestFee: 2,
        halfHourFee: 3,
        hourFee: 6,
        economyFee: 144,
      },
      // ECONOMICAL tracks the live mempool more closely than CONSERVATIVE's
      // built-in safety margin; switched after CONSERVATIVE reported
      // meaningfully higher tiers than mempool.space during a quiet mempool
      // (e.g. 4/3/2/1/1 vs mempool.space's flat 1/1/1/1/1 at the same time).
      // Absolute difference is small in real terms, but this tracks the
      // public reference more closely for easier sanity-checking.
      estimateMode: cfg.fee?.estimateMode ?? "ECONOMICAL",
      floorSatVb: cfg.fee?.floorSatVb ?? 1,
    },
    utxo: {
      maxPerResponse: cfg.utxo?.maxPerResponse ?? 150,
    },
    history: {
      maxTxs: cfg.history?.maxTxs ?? 500,
    },
    xpub: {
      // Raised from the kiosk's existing 5-address convention after finding
      // a real wallet with a 21-address unused run (indices 79-99) followed
      // by further usage at 100+ — a gap limit of 5 silently misses funds in
      // that pattern, on the bridge and (if OnChainPayoutManager also uses
      // 5) potentially on the kiosk's own existing scans too.
      gapLimit: cfg.xpub?.gapLimit ?? 30,
      maxGapLimit: cfg.xpub?.maxGapLimit ?? 50,
      maxAddresses: cfg.xpub?.maxAddresses ?? 100,
    },
    batch: {
      // Shared by chain.address.stats.batch and chain.address.utxo.batch.
      // Sized against the same 35,000-byte reply budget bridge.js enforces:
      // a stats entry is small and fixed-size (~216 bytes, doesn't grow with
      // activity), but a utxo entry scales with how many UTXOs that address
      // holds — at a realistic ~2-3 UTXOs/address average, 50 addresses
      // lands close to the budget's edge. Kept equal across both methods for
      // one predictable number rather than two, at some unused headroom on
      // the stats side.
      maxAddresses: cfg.batch?.maxAddresses ?? 50,
    },
  };
}
