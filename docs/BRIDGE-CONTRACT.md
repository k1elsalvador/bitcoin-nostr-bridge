# Bitcoin Nostr Bridge — Contract (as built)

**Naming note:** your own handoff brief (`docs/electrum-nostr-bridge-contract.md`) refers to this
service as `ElectrumNostrBridge` throughout. It's since been published as `bitcoin-nostr-bridge` —
same project, renamed because it already answers fee/broadcast/tx-status queries via Bitcoin Core
directly (not just Fulcrum/Electrum-protocol data), and to leave room for Lightning later. Nothing
about the wire protocol below changed, only the repo/package name.

**Audience:** the kiosk team (`MiniPlusApp`, `OnChainPayoutManager`). This is the response to
`docs/electrum-nostr-bridge-contract.md` (your handoff brief) — the bridge is built exactly to
that brief's transport mechanics, borrowed from `docs/nostr-configuration-contract.md`. This
document restates the parts you need to integrate against and resolves every open question the
brief left for whoever built the bridge.

Nothing here diverges from your brief's transport mechanics (NIP-44, tags, kinds, envelope shape).
The only things decided on this side are the four items the brief explicitly flagged as open.

## What's live right now

- **Bridge npub:** communicated separately, out of band — not published in this repo.
- **Relays:** communicated separately, same reasoning. The bridge supports a relay *list* (see
  below), so more can be added without a bridge-side code change.

The deployed identity is test-only and will rotate for production; nothing about the wire protocol
changes when that happens, only the npub you address queries to.

## Resolved: the brief's open questions

| Question | Decision |
|---|---|
| Trust model | **Open** — the bridge answers any Query it receives, no allowlist, for now. The config already has an `allowlist` mode wired in and unused, so this can tighten later without a code change if it ever needs to. |
| Kind numbers | `3920` (Query) / `3921` (Reply), exactly as suggested. |
| UTXO response size | Capped, not paginated — see "Known limitations" below. |
| Relay selection | **Multi-relay from day one**, not single-relay. The bridge connects, subscribes, and publishes replies across every relay in its configured list (currently a single relay — see "What's live right now" above for how to get it), mirroring the resilience model in your own config-protocol doc. |

## Method reference (five from your brief, unchanged, plus one new addition)

Namespace `chain.*`. Every result mirrors mempool.space's own JSON shape.

| Method | `params` | `result` |
|---|---|---|
| `chain.address.stats` | `{"address": "bc1q..."}` | `{address, chain_stats: {funded_txo_count, spent_txo_count, tx_count}, mempool_stats: {same}}` |
| `chain.address.utxo` | `{"address": "bc1q..."}` | array of `{txid, vout, value, status: {confirmed, block_height?, block_hash?}}` |
| `chain.fee.recommended` | `{}` | `{fastestFee, halfHourFee, hourFee, economyFee, minimumFee}` — all `Int`, sat/vB |
| `chain.tx.broadcast` | `{"rawHex": "..."}` | `{txid}` |
| `chain.tx.status` | `{"txid": "<64-hex>"}` | `{txid, status: {confirmed, block_height?, block_hash?}}` |
| `chain.xpub.balance` | `{"xpub": "xpub.../ypub.../zpub...", "gapLimit"?: Int}` | `{xpub, gapLimit, addressesScanned, complete, chain_stats: {...}, mempool_stats: {...}, utxos: [...]}` — see below |

All six verified end-to-end against this deployment's live Fulcrum + Bitcoin Core node, over the
real relay, using a throwaway test keypair speaking the exact envelope below — including that
`chain.address.stats`'s computed `funded_txo_count`/`spent_txo_count`/`tx_count` match
mempool.space's own numbers exactly for the same address (94/94/166 in the test run), and that
`chain.xpub.balance` rediscovered a real, independently-verified wallet UTXO at the correct
derivation path (see below). `value` and fee amounts are satoshis (`Int`), same as mempool.space.

### Envelope (unchanged)

Query (NIP-44-encrypted `content`):
```json
{ "v": 1, "id": "<opaque, unique per request>", "method": "chain.address.stats", "params": { "address": "bc1q..." }, "ts": 1234567890 }
```

Reply:
```json
{ "v": 1, "id": "<same id>", "ok": true, "result": { } }
{ "v": 1, "id": "<same id>", "ok": false, "error": "human-readable message" }
```

`v` defaults to `1` if omitted on the Query. A `v` the bridge doesn't support gets
`{v, id, ok:false, error:"Unsupported protocol version: ..."}` back. An unrecognized `method` gets
`{ok:false, error:"Unknown method"}`. A Query the bridge can't decrypt or parse gets **no reply at
all** — same silent-drop convention as your own config protocol for malformed/untrusted input.

### Error strings you'll actually see

These aren't a fixed enum — treat `error` as a human-readable string for logs/diagnostics, not
something to pattern-match — but in practice:

- `"params.address (string) is required"` / `"params.rawHex (hex string) is required"` /
  `"params.txid (64-char hex string) is required"` — malformed `params`.
- `"Transaction not found"` — `chain.tx.status` on a txid the node doesn't know (not in mempool or
  any block it has).
- `"Address history too large to summarize (N transactions, limit 500)"` — see known limitations.
- Anything else from `chain.tx.broadcast` is Bitcoin Core's own `sendrawtransaction` rejection
  reason verbatim (e.g. `"TX decode failed..."`, `"bad-txns-inputs-missingorspent"`,
  `"min relay fee not met"`) — worth surfacing to the operator/log as-is, it's the same signal
  you'd get from mempool.space's `POST /api/tx` today.

## Recommended: timeout/retry on your side

Your brief flags this as unestablished kiosk-side territory, since the kiosk has never been the
initiating side before. Suggestion, not a hard requirement:

- **Timeout: 10–15 seconds** per Query before giving up on that `id`. Everything above resolved in
  well under a second against this deployment in testing; double digits of seconds gives headroom
  for a relay hiccup without leaving a payout flow hanging.
- **One retry** with a **new** Query event (fresh `id`, fresh `created_at`) on timeout, not a resend
  of the same signed event — a relay that dropped it once may have a stale view. If the retry also
  times out, surface it as a backend-unavailable error the same way a mempool.space timeout would
  be handled today; nothing about this bridge changes what "the chain-data backend is unreachable"
  means to the rest of `OnChainPayoutManager`.
- Match on the Reply's `id`, not on any relay-level correlation — a Reply can arrive on any relay
  in your list, not necessarily the one you published the Query to.

## Known limitations

- **`chain.address.utxo` errors out rather than silently truncating** — since the wire shape is a
  bare array (matching mempool.space's own shape), there's no room for a truncation flag on
  success, and a client summing `value` for a balance has no way to tell a truncated array from a
  complete one. So instead of shrinking the array and still returning `ok:true`, the bridge returns
  `{ok:false, error:"..."}` if an address has more UTXOs than it can return in one reply (150,
  configurable) — comfortably above any realistic kiosk wallet address's live UTXO count. If a real
  address ever needs more than this holds, the fix is pagination (a `cursor` param), not built yet.
  (Earlier revision of this bridge silently trimmed instead — changed after a security review found
  that a truncated-but-`ok:true` reply is a real fund-safety risk, not just a wire-size nuisance.)
- **`chain.address.stats` refuses addresses with more than 500 transactions in their full history**
  (`"Address history too large to summarize"`), rather than hanging. Esplora-style funded/spent
  counts aren't something Electrum's protocol gives directly — the bridge computes them by walking
  every tx that ever touched the address, which is cheap for a normal wallet address (a handful of
  txs) but would mean fetching tens of thousands of transactions one by one for a famous, heavily
  reused address. Since the bridge currently answers any requester (see trust model above), this
  cap exists specifically so an arbitrary/adversarial query can't turn into a multi-minute hang —
  it should never be hit by a real kiosk querying its own wallet's addresses.

## `chain.xpub.balance` — xpub/zpub aggregation

One query that takes an account-level extended pubkey and returns balance + UTXOs across every
derived address that's ever been used, instead of one `chain.address.*` call per address. Built on
top of the same `chain.address.stats`/`chain.address.utxo` logic (per-address, not a parallel
implementation) — this method does the BIP44/49/84 gap-limit derivation and aggregates.

- **Input key**: `xpub`/`ypub`/`zpub` (mainnet) — must be an **account-level** key, i.e. what you'd
  get at `m/44'/0'/0'` (xpub → legacy P2PKH), `m/49'/0'/0'` (ypub → P2SH-wrapped SegWit), or
  `m/84'/0'/0'` (zpub → native SegWit). A master key or a receive/change-level key is rejected
  (`"Expected an account-level extended pubkey (BIP44/49/84 depth 3)..."`) rather than silently
  scanning the wrong tree. Testnet `tpub`/`upub`/`vpub` supported too, tied to the bridge's
  configured network (currently mainnet).
- **`gapLimit`** (optional): consecutive-unused-address stopping point per chain (external/change).
  Defaults to **30**. Originally set to 5 to match `OnChainPayoutManager.scanUtxos()`'s own
  existing convention, but raised after testing against a real wallet that had a genuine
  21-address unused run (indices 79-99 on the external chain) followed by further real usage at
  100+ — a gap limit of 5 silently undercounts balance in that pattern, since it stops scanning
  long before reaching the still-used addresses past the gap. **Worth checking**:
  `OnChainPayoutManager.scanUtxos()` uses the same "stop after N consecutive unused" logic with
  `N=5` today (per its own `docs/TODO.md`) — if any of your wallets have a comparable usage gap,
  the kiosk's own existing balance/UTXO scan may be undercounting it the same way, independent of
  this bridge. Capped server-side at 50 regardless of what's requested (the response's own
  `gapLimit` field tells you what was actually used, in case your request got clamped).
- **`result.utxos`** entries carry `address` and `path` (e.g. `"0/3"` = external chain, index 3) in
  addition to the usual `txid, vout, value, status` — you need the derivation path to know which
  key to sign with when spending, which a bare mempool.space-shaped UTXO doesn't carry.
- **`result.chain_stats`/`mempool_stats`** are the same fields as `chain.address.stats`, just
  summed across every used address instead of one.
- **`result.complete`** (`Boolean`) — `false` means the scan was cut off by the 100-used-address
  safety cap before it naturally reached `gapLimit` consecutive unused addresses on both chains;
  treat `chain_stats`/`mempool_stats`/`utxos` as a **lower bound**, not authoritative, when this is
  `false`. `true` means the scan ran to its normal completion. Far above what a real wallet
  accumulates for this app's usage pattern — this should never read `false` in practice, but check
  it rather than assume.
- If the combined `utxos` array is too large to fit in one Nostr reply even after the per-address
  cap (`chain.address.utxo`'s own limit applies per address, not to the total), the whole query
  returns `{ok:false, error:"..."}` rather than a silently incomplete result — same reasoning as
  `chain.address.utxo` above.

**Verification**: tested against both a fresh empty wallet (correctly scans to the gap limit on
both chains and returns all-zero stats/no UTXOs) and a real funded zpub — the latter found 3 UTXOs
totaling 2,152,421 sats across 80 scanned addresses, and one of those UTXOs matched, field-for-field
(txid, vout, value, block height), a UTXO independently confirmed earlier via a plain
`chain.address.stats`/`chain.address.utxo` call on that same address — good evidence the derivation
reconstructs real wallet addresses correctly rather than just producing well-formed nonsense.

**Performance note for your timeout tuning**: unlike the other five methods (sub-second against
this deployment), a `gapLimit: 30` scan takes on the order of **5-6 seconds** — the "Recommended:
timeout/retry" section above (10-15s) was written before this method existed; it still holds as a
floor, but budget on the higher end specifically for `chain.xpub.balance` calls.
