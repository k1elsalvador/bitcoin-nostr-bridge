# Bitcoin Nostr Bridge

A backend service that fronts a private Fulcrum + Bitcoin Core node and answers Bitcoin chain-data
queries from a kiosk fleet over Nostr, instead of the kiosks calling mempool.space's rate-limited
public API directly. Originally built for K1 Technology's MiniPlusApp, running on their Bitcoin
Vending Machines.

No UI. It listens on a Nostr npub, decrypts incoming queries, checks Fulcrum/Bitcoin Core locally,
and replies encrypted to the requester. See [`docs/BRIDGE-CONTRACT.md`](docs/BRIDGE-CONTRACT.md)
for the full wire protocol handed to the kiosk team — the underlying design (self-host your own
Fulcrum/Core, answer mempool.space-shaped queries over Nostr instead of a rate-limited public API)
isn't specific to this fleet, if you're running into the same rate-limit problem elsewhere.

## Requirements

- Node.js 18+ (uses global `fetch`; developed/tested on Node 24).
- A reachable Fulcrum instance (Electrum protocol, TCP or TLS).
- A reachable Bitcoin Core node with `txindex=1`, RPC enabled.
- No native build tools needed — every dependency is pure JS, so this runs the same on Windows
  today and Ubuntu after the planned move.

## Setup

```sh
npm install
cp config.example.json config.json
node tools/generate-identity.js
```

Edit `config.json` (gitignored — never commit real credentials):

- `identity.nsec` — the bridge's own Nostr key. Paste in the nsec `generate-identity.js` just
  printed. **Generate your own — never reuse someone else's example/test key.** Every bridge needs
  a unique identity; two bridges sharing an nsec would both answer on the same npub and collide on
  any relay they share.
- `fulcrum.{host,port,tls}` — point at your Fulcrum instance. Fulcrum's default TLS port is 50002;
  if it's only bound on the plaintext port (50001) on your LAN, set `"tls": false`.
  `fulcrum.tlsRejectUnauthorized` (default `true`) verifies Fulcrum's TLS certificate — only set it
  to `false` for a self-signed cert you've verified out-of-band on a network you trust; disabling it
  makes the connection vulnerable to on-path tampering (a warning is logged on startup if you do).
- `bitcoinCore.{host,port,user,password}` — RPC credentials for a node with `txindex=1`.
- `trust.mode` — `"open"` (answer anyone) or `"allowlist"` (only `trust.trustedPubkeys`, npub or
  hex). **Defaults to `"allowlist"`** if omitted — a new deployment starts closed until you
  configure it. This deployment's own `config.json` explicitly sets `"open"`, a deliberate choice,
  not the default.
- `relays` — list of relay URLs. The bridge connects, subscribes, and publishes replies across all
  of them.
- `xpub.{gapLimit,maxGapLimit,maxAddresses}` — `chain.xpub.balance`'s gap-limit scan defaults and
  safety caps. See `docs/BRIDGE-CONTRACT.md` for what each controls.
- `batch.maxAddresses` — max addresses per `chain.address.stats.batch`/`chain.address.utxo.batch`
  call. See `docs/BRIDGE-CONTRACT.md` for the sizing rationale.

## Run

```sh
npm start
```

Logs its own npub/pubkey and trust mode on startup, then listens. `Ctrl+C` (SIGINT) or SIGTERM
shuts it down cleanly.

## Deployment

Runs comfortably alongside Fulcrum + Bitcoin Core on the same box — idle RSS is well under 100MB
(measured ~85-95MB bare-metal, ~20-25MB freshly started in Docker), a rounding error next to what
Fulcrum/Core themselves typically use. Every option below caps the process at a hard memory ceiling
anyway (128-256MB) as a safety net on RAM-constrained hosts, not because it's expected to need it.

### Windows — NSSM (recommended for RAM-constrained hosts)

[NSSM](https://nssm.cc/download) wraps the process as a native Windows service — a single
long-proven binary, no extra Node dependencies, no Docker Desktop VM overhead (which reserves
1-2GB+ via WSL2/Hyper-V and isn't worth it on a tight-RAM box).

```powershell
# Download nssm.exe from https://nssm.cc/download, put it on PATH, then from
# an elevated PowerShell prompt in this repo:
.\deploy\windows\install-service.ps1
```

Installs, starts, and configures auto-restart-on-crash. Live log: `Get-Content -Wait logs\bridge.log`.
Uninstall with `.\deploy\windows\uninstall-service.ps1`.

### Linux — systemd

```sh
sudo ./deploy/linux/install-service.sh
```

Installs a `bitcoin-nostr-bridge.service` unit (auto-generated from
`deploy/linux/bitcoin-nostr-bridge.service.template` with this checkout's actual paths), enables
it, and starts it. Live log: `journalctl -u bitcoin-nostr-bridge -f`.

### Docker (optional, Linux hosts preferred)

```sh
cp config.example.json config.json   # fill it in first
docker compose up -d --build
```

Verified to build and run on `node:20-alpine` with no native-dependency issues, and to reach both
the relay and a LAN Fulcrum/Core node from inside the container. Not recommended on the
RAM-constrained Windows box specifically — Docker Desktop's VM overhead alone dwarfs what this
service actually uses. Live log: `docker compose logs -f`.

If Fulcrum/Core run on the *same* machine as Docker (rather than elsewhere on the LAN), point
`config.json`'s `fulcrum.host`/`bitcoinCore.host` at `host.docker.internal` and uncomment the
`extra_hosts` line in `docker-compose.yml`.

## Monitoring

Every query gets one or two log lines, safe to `tail -f` / `journalctl -f` / `Get-Content -Wait` —
colored when attached to a terminal, plain text when redirected to a file:

```
21:39:27.037 IN  9c756c59 chain.address.stats      from 0fc3949c1b
21:39:28.118 OK  9c756c59 chain.address.stats      from 0fc3949c1b fulcrum=776ms core=0ms backend=823ms publish=252ms total=1081ms
```

- `IN` — a valid query was received (logged immediately, before any backend work starts, so a
  slow `chain.xpub.balance` scan shows as in-progress rather than looking hung).
- `OK`/`ERR` — the final outcome, with a full timing breakdown: `fulcrum`/`core` are wall-clock time
  this specific request had at least one Fulcrum/Core RPC call in flight (never exceeds `backend`,
  even when a method fires several backend calls concurrently); `backend` is the whole handler's
  wall time; `publish` is NIP-44 encrypt + relay publish; `total` is the full round trip.
- `DROP` — an event addressed to the bridge that wasn't a valid query (wrong trust, undecryptable,
  malformed) — logged at low volume, one line, useful for diagnosing a misconfigured kiosk without
  digging through relay traffic.

The requester pubkey shown is truncated to 10 hex chars — enough to tell requesters apart at a
glance without a full 64-char line.

## Verifying it works

Two standalone scripts, independent of the bridge itself:

**1. Learn/confirm mempool.space's actual response shapes** (no bridge needed — hits the real
public API):

```sh
node tools/mempool-probe.js <a-real-address> <a-real-confirmed-txid>
```

Saves raw JSON to `test/fixtures/*.json` and prints it. Useful as ground truth when comparing
against the bridge's own output for the same address/txid.

**2. End-to-end test against the running bridge** (acts as a fake kiosk — real Nostr round-trip,
real NIP-44 encryption, real relay):

```sh
npm start &                 # start the bridge first
node tools/test-client.js chain.address.stats '{"address":"bc1q..."}'
node tools/test-client.js chain.address.utxo '{"address":"bc1q..."}'
node tools/test-client.js chain.address.stats.batch '{"addresses":["bc1q...","bc1q..."]}'
node tools/test-client.js chain.address.utxo.batch '{"addresses":["bc1q...","bc1q..."]}'
node tools/test-client.js chain.fee.recommended
node tools/test-client.js chain.tx.status '{"txid":"<64-hex>"}'
node tools/test-client.js chain.tx.broadcast '{"rawHex":"<signed-tx-hex>"}'
node tools/test-client.js chain.xpub.balance '{"xpub":"zpub..."}'
```

Prints the decrypted Reply envelope and exits `0` on `ok:true`, `2` on `ok:false`, `1` on timeout
(15s default — override with `TEST_CLIENT_TIMEOUT_MS=30000` for `chain.xpub.balance`, which takes
several seconds longer than the other methods; see `docs/BRIDGE-CONTRACT.md`). Compare the
`chain.address.stats`/`chain.address.utxo`/`chain.tx.status` output against the `mempool-probe.js`
fixtures for the same address/txid to confirm shape parity.

`chain.tx.broadcast` is the one method that's inherently hard to test without spending real funds
— point it at a real signed transaction's hex when you have one, or a garbage hex string to confirm
Bitcoin Core's rejection path comes back as a readable `error`.

## Project layout

- `src/chain/` — backend logic (Fulcrum/Bitcoin Core queries), no Nostr awareness. Pure
  `address in, mempool.space-shaped data out` functions; `xpubBalance.js`/`xpubKeys.js` build on
  these for the gap-limit-scanned `chain.xpub.balance` method (see `docs/BRIDGE-CONTRACT.md`).
- `src/methods/` — thin wire adapters: validate `params`, call `src/chain/*`, shape into `result`.
- `src/fulcrum.js` / `src/bitcoinRpc.js` — protocol clients.
- `src/bridge.js` / `src/index.js` — Nostr transport (subscribe, decrypt, dispatch, encrypt,
  publish) and process entry point.
- `src/log.js` / `src/busyTimer.js` — the live request log and its per-backend timing tracking.
- `tools/` — `generate-identity.js` (new deployment setup) plus the two verification scripts above.
- `deploy/windows/`, `deploy/linux/` — service install scripts for each platform (see Deployment).
- `Dockerfile` / `docker-compose.yml` — optional container deployment path.

## License

[MIT](LICENSE).
