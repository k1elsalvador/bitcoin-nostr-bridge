#!/usr/bin/env node
/**
 * Bridge diagnostics, independent of the running bridge process (it only
 * reads config.json — so it still works when the bridge itself is the thing
 * that's broken).
 *
 * Usage:
 *   node tools/diagnose.js [check] [--no-e2e] [--debug] [--service <name>]
 *   node tools/diagnose.js watch [--verbose] [--reply-timeout <sec>]
 *   (either mode also takes --config <path>, default ./config.json)
 *
 * check — Bitcoin Core RPC, Fulcrum, each relay (connect, NIP-11, read, write),
 *   then a per-relay end-to-end round trip (chain.fee.recommended sent to ONE
 *   relay at a time), which pinpoints a relay the bridge isn't hearing on.
 *   Exits 0 if everything passed, 1 otherwise. On any failure (or with
 *   --debug) it also dumps the systemd service's status, recent journal,
 *   connection/subscription history, and the deployed git commit — run it
 *   with sudo so journalctl can read the service's log.
 *
 * watch — live tap on every configured relay: prints each event addressed to
 *   the bridge's npub and each reply the bridge publishes, both decrypted with
 *   the bridge's own key, flags anything the bridge would silently drop (stale
 *   created_at, untrusted pubkey, wrong kind, undecryptable, bad envelope),
 *   and reports queries that got no reply within --reply-timeout (default 15s).
 */
import WebSocket from "ws";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { FulcrumClient } from "../src/fulcrum.js";
import { BitcoinRpcClient } from "../src/bitcoinRpc.js";

useWebSocketImplementation(WebSocket);

// Must match bridge.js's FRESHNESS_WINDOW_SECONDS.
const FRESHNESS_WINDOW_SECONDS = 300;
const STEP_TIMEOUT_MS = 8000;
const E2E_TIMEOUT_MS = 15000;
const DEFAULT_SERVICE = "bitcoin-nostr-bridge";
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const isTTY = Boolean(process.stdout.isTTY);
const CODES = { reset: "\x1b[0m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m", magenta: "\x1b[35m" };
const paint = (code, text) => (isTTY ? `${code}${text}${CODES.reset}` : text);
const timestamp = () => new Date().toISOString().slice(11, 23);
const shortHex = (hex) => (hex ?? "").slice(0, 10);
const truncate = (str, max) => (str.length > max ? `${str.slice(0, max)}...` : str);

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errText(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  return err.cause?.message ? `${err.message} (${err.cause.message})` : err.message ?? String(err);
}

// ---------------------------------------------------------------- check mode

let failures = 0;
function pass(label, detail = "") {
  console.log(`  ${paint(CODES.green, "PASS")} ${label}${detail ? paint(CODES.dim, `  ${detail}`) : ""}`);
}
function warn(label, detail = "") {
  console.log(`  ${paint(CODES.yellow, "WARN")} ${label}${detail ? `  ${detail}` : ""}`);
}
function fail(label, detail = "") {
  failures++;
  console.log(`  ${paint(CODES.red, "FAIL")} ${label}${detail ? `  ${detail}` : ""}`);
}

async function checkCore(config) {
  console.log(`\nBitcoin Core  http://${config.bitcoinCore.host}:${config.bitcoinCore.port}/`);
  const rpc = new BitcoinRpcClient(config.bitcoinCore);
  let info;
  try {
    const t0 = Date.now();
    info = await withTimeout(rpc.call("getblockchaininfo"), STEP_TIMEOUT_MS, "getblockchaininfo");
    pass("RPC reachable + authenticated", `${Date.now() - t0}ms, chain=${info.chain}`);
  } catch (err) {
    fail("RPC getblockchaininfo", errText(err));
    return null;
  }

  if (info.initialblockdownload || info.blocks < info.headers) {
    warn("still syncing", `blocks=${info.blocks} headers=${info.headers} progress=${(info.verificationprogress * 100).toFixed(2)}%`);
  } else {
    pass("synced", `height=${info.blocks}`);
  }

  try {
    const idx = await withTimeout(rpc.call("getindexinfo", ["txindex"]), STEP_TIMEOUT_MS, "getindexinfo");
    if (!idx.txindex) fail("txindex", "not enabled — set txindex=1 (chain.tx.status needs it)");
    else if (!idx.txindex.synced) warn("txindex", `still building (best_block_height=${idx.txindex.best_block_height})`);
    else pass("txindex enabled + synced");
  } catch (err) {
    warn("txindex", `couldn't check: ${errText(err)}`);
  }

  try {
    const net = await withTimeout(rpc.call("getnetworkinfo"), STEP_TIMEOUT_MS, "getnetworkinfo");
    if (net.connections === 0) warn("peers", "0 connections — node is isolated, broadcasts won't propagate");
    else pass("peers", `${net.connections} connections, ${net.subversion}`);
  } catch (err) {
    warn("peers", `couldn't check: ${errText(err)}`);
  }
  return info.blocks;
}

async function checkFulcrum(config, coreHeight) {
  const { host, port, tls } = config.fulcrum;
  console.log(`\nFulcrum  ${tls ? "tls" : "tcp"}://${host}:${port}`);
  const fulcrum = new FulcrumClient(config.fulcrum);
  try {
    const t0 = Date.now();
    await withTimeout(fulcrum.connect(), STEP_TIMEOUT_MS, "connect");
    pass("connected", `${Date.now() - t0}ms`);

    const features = await withTimeout(fulcrum.request("server.features"), STEP_TIMEOUT_MS, "server.features");
    pass("server.features", `${features.server_version ?? "?"}, protocol ${features.protocol_max ?? "?"}`);

    const tip = await withTimeout(fulcrum.request("blockchain.headers.subscribe"), STEP_TIMEOUT_MS, "blockchain.headers.subscribe");
    if (coreHeight == null) {
      pass("tip", `height=${tip.height} (Core unavailable to compare)`);
    } else if (Math.abs(coreHeight - tip.height) > 2) {
      warn("tip behind Core", `fulcrum=${tip.height} core=${coreHeight} — Fulcrum still indexing or stuck`);
    } else {
      pass("tip matches Core", `height=${tip.height}`);
    }
  } catch (err) {
    fail("Fulcrum", errText(err));
  } finally {
    fulcrum.close();
  }
}

async function fetchNip11(url) {
  const httpUrl = url.replace(/^ws(s?):\/\//, "http$1://");
  const res = await withTimeout(
    fetch(httpUrl, { headers: { Accept: "application/nostr+json" } }),
    STEP_TIMEOUT_MS,
    "NIP-11 fetch",
  );
  const dateHeader = res.headers.get("date");
  let info = null;
  try {
    info = await res.json();
  } catch {
    // not every relay serves NIP-11
  }
  return { info, serverDate: dateHeader ? new Date(dateHeader) : null };
}

async function checkRelay(config, url) {
  console.log(`\nRelay  ${url}`);
  const bridgePubkey = config.identity.pubkeyHex;

  try {
    const { info, serverDate } = await fetchNip11(url);
    if (info) {
      const lim = info.limitation ?? {};
      const flags = [lim.auth_required && "auth_required", lim.restricted_writes && "restricted_writes", lim.payment_required && "payment_required"].filter(Boolean);
      pass("NIP-11", `${info.software ?? "?"} ${info.version ?? ""}${flags.length ? `, ${flags.join(", ")}` : ""}`.trim());
      if (flags.length) warn("relay restrictions", `${flags.join(", ")} — kiosks/bridge may be refused writes or reads`);
    } else {
      warn("NIP-11", "no relay info document (not fatal)");
    }
    if (serverDate) {
      const skew = Math.round((Date.now() - serverDate.getTime()) / 1000);
      if (Math.abs(skew) > 60) warn("clock skew vs relay", `${skew}s — bridge drops queries outside ±${FRESHNESS_WINDOW_SECONDS}s, check NTP here and on clients`);
      else pass("clock vs relay", `${skew >= 0 ? "+" : ""}${skew}s`);
    }
  } catch (err) {
    warn("NIP-11", errText(err));
  }

  let relay;
  try {
    const t0 = Date.now();
    relay = await withTimeout(Relay.connect(url), STEP_TIMEOUT_MS, "websocket connect");
    pass("websocket connected", `${Date.now() - t0}ms`);
  } catch (err) {
    fail("websocket connect", errText(err));
    return { url, ok: false };
  }

  // Read path: the bridge's own recent replies, which also tells us whether
  // the bridge has been answering anyone on this relay lately.
  try {
    const replies = await withTimeout(
      new Promise((resolve, reject) => {
        const got = [];
        const sub = relay.subscribe([{ kinds: [config.kinds.reply], authors: [bridgePubkey], limit: 20 }], {
          onevent: (e) => got.push(e),
          oneose: () => { resolve(got); sub.close(); },
          onclose: (reason) => reject(new Error(`subscription closed: ${reason}`)),
        });
      }),
      STEP_TIMEOUT_MS,
      "REQ/EOSE",
    );
    if (replies.length === 0) {
      pass("read (REQ/EOSE)", "no stored bridge replies (normal if idle >15min — replies carry a NIP-40 expiration)");
    } else {
      const newest = Math.max(...replies.map((e) => e.created_at));
      const ago = Math.floor(Date.now() / 1000) - newest;
      pass("read (REQ/EOSE)", `last bridge reply ${ago}s ago (${replies.length} stored)`);
    }
  } catch (err) {
    fail("read (REQ/EOSE)", errText(err));
  }

  relay.close();
  return { url, ok: true };
}

async function e2eViaRelay(config, url) {
  const bridgePubkey = config.identity.pubkeyHex;
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const conversationKey = nip44.getConversationKey(clientSecretKey, bridgePubkey);
  const queryId = `diag-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const signedQuery = finalizeEvent(
    {
      kind: config.kinds.query,
      created_at: now,
      tags: [["p", bridgePubkey], ["expiration", String(now + config.expirationSeconds)]],
      content: nip44.encrypt(JSON.stringify({ v: 1, id: queryId, method: "chain.fee.recommended", params: {}, ts: now }), conversationKey),
    },
    clientSecretKey,
  );

  let relay;
  try {
    relay = await withTimeout(Relay.connect(url), STEP_TIMEOUT_MS, "websocket connect");
  } catch (err) {
    fail(`e2e ${url}`, errText(err));
    return;
  }

  try {
    const t0 = Date.now();
    const replyPromise = new Promise((resolve) => {
      relay.subscribe([{ kinds: [config.kinds.reply], "#p": [clientPubkey], since: now - 5 }], {
        onevent: (event) => {
          try {
            const envelope = JSON.parse(nip44.decrypt(event.content, conversationKey));
            if (envelope.id === queryId) resolve(envelope);
          } catch {
            // not ours
          }
        },
      });
    });

    try {
      const msg = await withTimeout(relay.publish(signedQuery), STEP_TIMEOUT_MS, "publish");
      pass(`write: relay accepted query`, msg ? `"${msg}"` : "");
    } catch (err) {
      fail(`write: relay rejected query`, errText(err));
      return;
    }

    try {
      const reply = await withTimeout(replyPromise, E2E_TIMEOUT_MS, "waiting for bridge reply");
      if (reply.ok) pass("bridge replied", `${Date.now() - t0}ms round trip`);
      else fail("bridge replied with error", reply.error);
    } catch {
      // Distinguish "relay doesn't serve the query back" from "bridge never answered".
      let stored = false;
      try {
        stored = await withTimeout(
          new Promise((resolve) => {
            let found = false;
            const sub = relay.subscribe([{ ids: [signedQuery.id] }], {
              onevent: () => { found = true; },
              oneose: () => { resolve(found); sub.close(); },
            });
          }),
          STEP_TIMEOUT_MS,
          "query lookup",
        );
      } catch {
        // fall through with stored=false
      }
      fail(
        `no reply within ${E2E_TIMEOUT_MS / 1000}s`,
        stored
          ? "relay stored the query, so the bridge isn't hearing this relay (not running? not subscribed? check its log for IN/DROP)"
          : "relay accepted but won't serve the query back — the relay itself is dropping kind " + config.kinds.query,
      );
    }
  } finally {
    relay.close();
  }
}

// Same commands an operator would run by hand after a failed check, so the
// output of one diagnose run is enough to work out what happened.
function dumpServiceDebug(service) {
  const sections = [
    [`systemctl status ${service}`, "systemctl", ["status", service, "--no-pager", "-l"]],
    [`journalctl -u ${service} -n 60`, "journalctl", ["-u", service, "-n", "60", "--no-pager", "-l"]],
    [
      `journalctl -u ${service}  (connection/subscription history)`,
      "journalctl",
      ["-u", service, "--no-pager", "-l", "--grep", "listening as|subscription|DOWN|UP  |shutting down|Error"],
      (out) => out.split("\n").slice(-30).join("\n"),
    ],
    ["deployed commit", "git", ["-c", `safe.directory=${PROJECT_ROOT}`, "-C", PROJECT_ROOT, "log", "-1", "--format=%h %ad %s", "--date=iso"]],
    ["working tree changes", "git", ["-c", `safe.directory=${PROJECT_ROOT}`, "-C", PROJECT_ROOT, "status", "--short"]],
  ];

  console.log(paint(CODES.yellow, `\n===== debug info (service: ${service}) =====`));
  for (const [title, cmd, cmdArgs, post] of sections) {
    console.log(paint(CODES.cyan, `\n--- ${title}`));
    let out;
    try {
      out = execFileSync(cmd, cmdArgs, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // systemctl status exits non-zero for a stopped/failed unit but still
      // prints exactly what we want; journalctl --grep exits 1 on no match.
      out = `${err.stdout ?? ""}${err.stderr ?? ""}` || errText(err);
    }
    out = (post ? post(out) : out).trimEnd();
    console.log(out || paint(CODES.dim, "(no output)"));
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.log(paint(CODES.dim, "\n(not root — if the journal sections are empty or denied, re-run with sudo)"));
  }
}

async function runCheck(args) {
  const config = loadConfig(configPath(args));
  console.log(`Bridge identity  ${config.identity.npub}`);
  console.log(`                 ${config.identity.pubkeyHex}`);
  console.log(`Trust mode       ${config.trust.mode}${config.trust.mode === "allowlist" ? ` (${config.trust.trustedPubkeys.size} trusted pubkeys)` : ""}`);
  console.log(`Kinds            query=${config.kinds.query} reply=${config.kinds.reply}`);

  const coreHeight = await checkCore(config);
  await checkFulcrum(config, coreHeight);
  const relayResults = [];
  for (const url of config.relays) relayResults.push(await checkRelay(config, url));

  if (!args.includes("--no-e2e")) {
    console.log(`\nEnd-to-end (chain.fee.recommended, one relay at a time)`);
    if (config.trust.mode === "allowlist") {
      warn("skipped", "trust.mode is allowlist — the bridge silently drops this tool's throwaway key");
    } else {
      for (const { url, ok } of relayResults) {
        if (!ok) continue;
        console.log(`  ${paint(CODES.dim, url)}`);
        await e2eViaRelay(config, url);
      }
    }
  }

  console.log(failures === 0 ? paint(CODES.green, "\nAll checks passed.") : paint(CODES.red, `\n${failures} check(s) failed.`));
  if (failures > 0 || args.includes("--debug")) {
    if (process.platform === "linux") dumpServiceDebug(parseFlag(args, "--service", DEFAULT_SERVICE));
    else console.log(paint(CODES.dim, "(service debug dump is systemd-only; check the service log manually)"));
  }
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- watch mode

function parseFlag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function configPath(args) {
  return parseFlag(args, "--config", undefined);
}

async function runWatch(args) {
  const config = loadConfig(configPath(args));
  const verbose = args.includes("--verbose");
  const replyTimeoutMs = Number(parseFlag(args, "--reply-timeout", 15)) * 1000;
  const bridgePubkey = config.identity.pubkeyHex;
  const secretKey = config.identity.secretKey;
  const since = Math.floor(Date.now() / 1000);

  const seen = new Map(); // event id -> Set(relay url)
  const pending = new Map(); // query event id -> { timer, queryId, method, seenAt }

  const line = (tag, text) => console.log(`${timestamp()} ${tag} ${text}`);
  const detail = (obj) => {
    const json = JSON.stringify(obj, null, verbose ? 2 : 0);
    return verbose ? `\n${json}` : truncate(json, 160);
  };

  function decryptFrom(pubkey, content) {
    return nip44.decrypt(content, nip44.getConversationKey(secretKey, pubkey));
  }

  function onQuery(event, url) {
    const from = `from ${shortHex(event.pubkey)} via ${url}`;
    const problems = [];
    if (event.kind !== config.kinds.query) {
      problems.push(`kind ${event.kind}, bridge only listens on ${config.kinds.query}`);
    }
    const skew = Math.floor(Date.now() / 1000) - event.created_at;
    if (Math.abs(skew) > FRESHNESS_WINDOW_SECONDS) {
      problems.push(`created_at is ${skew}s off — outside ±${FRESHNESS_WINDOW_SECONDS}s, bridge drops it (sender clock wrong?)`);
    }
    if (config.trust.mode === "allowlist" && !config.trust.trustedPubkeys.has(event.pubkey)) {
      problems.push(`pubkey ${event.pubkey} not in trust.trustedPubkeys`);
    }

    let envelope;
    try {
      envelope = JSON.parse(decryptFrom(event.pubkey, event.content));
      if (typeof envelope.method !== "string" || typeof envelope.id !== "string") {
        problems.push("envelope missing string method/id");
      }
    } catch (err) {
      problems.push(`can't decrypt/parse as NIP-44 JSON (${errText(err)}) — wrong recipient npub, or NIP-04 instead of NIP-44?`);
    }

    const label = envelope ? `${envelope.id} ${envelope.method}` : event.id.slice(0, 16);
    const skewText = `skew=${skew >= 0 ? "+" : ""}${skew}s`;
    if (problems.length) {
      line(paint(CODES.red, "BAD "), `${label} ${from} ${skewText}`);
      for (const p of problems) console.log(`      ${paint(CODES.red, "->")} ${p} ${paint(CODES.dim, "(bridge will NOT reply)")}`);
      if (envelope && verbose) console.log(detail(envelope));
      return;
    }

    line(paint(CODES.cyan, "QRY "), `${label} ${from} ${skewText} params=${detail(envelope.params ?? {})}`);
    const timer = setTimeout(() => {
      pending.delete(event.id);
      const relays = [...(seen.get(event.id) ?? [])].join(", ");
      line(paint(CODES.red, "MISS"), `${label} no reply after ${replyTimeoutMs / 1000}s (query seen on: ${relays}) — check the bridge log for IN/ERR/DROP of this id`);
    }, replyTimeoutMs);
    pending.set(event.id, { timer, seenAt: Date.now() });
  }

  function onReply(event, url) {
    const requester = event.tags.find((t) => t[0] === "p")?.[1];
    const queryEventId = event.tags.find((t) => t[0] === "e")?.[1];
    const p = pending.get(queryEventId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(queryEventId);
    }
    const latency = p ? ` ${Date.now() - p.seenAt}ms after query` : "";

    let envelope;
    try {
      envelope = JSON.parse(decryptFrom(requester, event.content));
    } catch (err) {
      line(paint(CODES.yellow, "RPL?"), `to ${shortHex(requester)} via ${url} — can't decrypt (${errText(err)})`);
      return;
    }
    const status = envelope.ok ? paint(CODES.green, "RPL ") : paint(CODES.magenta, "RPL!");
    const body = envelope.ok ? `result=${detail(envelope.result)}` : `error="${envelope.error}"`;
    line(status, `${envelope.id} to ${shortHex(requester)} via ${url}${latency} ${body}`);
  }

  function onEvent(event, url) {
    const relays = seen.get(event.id);
    if (relays) {
      relays.add(url); // same event from another relay — already printed
      return;
    }
    seen.set(event.id, new Set([url]));
    if (seen.size > 20000) seen.clear();
    if (event.pubkey === bridgePubkey && event.kind === config.kinds.reply) onReply(event, url);
    else onQuery(event, url);
  }

  console.log(`Watching ${config.identity.npub} (query kind ${config.kinds.query}, reply kind ${config.kinds.reply}, trust ${config.trust.mode})`);
  console.log(paint(CODES.dim, "QRY=query  RPL=ok reply  RPL!=error reply  BAD=bridge will drop  MISS=no reply in time  Ctrl+C to stop\n"));

  const relays = [];
  let stopping = false;
  for (const url of config.relays) {
    const relay = new Relay(url, { enableReconnect: true, enablePing: true });
    relays.push(relay);
    relay
      .connect({ timeout: STEP_TIMEOUT_MS })
      .then(() => {
        line(paint(CODES.green, "UP  "), `relay ${url}`);
        relay.subscribe(
          [
            // Everything p-tagged to the bridge, any kind — so a client using
            // the wrong kind shows up as BAD instead of being invisible.
            { "#p": [bridgePubkey], since },
            { kinds: [config.kinds.reply], authors: [bridgePubkey], since },
          ],
          {
            onevent: (e) => onEvent(e, url),
            onclose: (reason) => stopping || line(paint(CODES.yellow, "CLSD"), `relay ${url} subscription closed: ${reason}`),
          },
        );
      })
      .catch((err) => line(paint(CODES.red, "DOWN"), `relay ${url} connect failed: ${errText(err)} (retrying in background)`));
  }

  // Connection-state transitions, same idea as bridge.js's watchdog.
  const lastState = new Map();
  setInterval(() => {
    for (const relay of relays) {
      const was = lastState.get(relay.url);
      if (was === true && !relay.connected) line(paint(CODES.yellow, "DOWN"), `relay ${relay.url} disconnected — reconnecting`);
      else if (was === false && relay.connected) line(paint(CODES.green, "UP  "), `relay ${relay.url} reconnected`);
      lastState.set(relay.url, relay.connected);
    }
  }, 5000);

  const shutdown = () => {
    stopping = true;
    for (const relay of relays) relay.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith("--") ? args[0] : "check";
if (mode === "check") runCheck(args);
else if (mode === "watch") runWatch(args);
else {
  console.error("Usage: node tools/diagnose.js [check [--no-e2e] [--debug] [--service <name>] | watch [--verbose] [--reply-timeout <sec>]] [--config <path>]");
  process.exit(1);
}
