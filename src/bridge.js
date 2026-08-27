import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";

import { methods } from "./methods/index.js";
import { logIncoming, logDropped, logResult, logConnectionChange } from "./log.js";

useWebSocketImplementation(WebSocket);

const PROTOCOL_VERSION = 1;

// Budget for the *plaintext* reply envelope, well under NIP-44's 65,535-byte
// ceiling to leave headroom for NIP-44 padding/base64 inflation (~1.4x) plus
// the outer signed event's own tags/sig/pubkey overhead — a relay rejecting
// an oversized published event ("event too large") is a silent failure from
// the requester's point of view (no reply is possible once that happens), so
// this has to be enforced before publishing, not just under NIP-44's own cap.
const REPLY_PLAINTEXT_BUDGET = 35000;

// How far event.created_at may drift from "now" (either direction, to allow
// for clock skew) before a query is rejected as stale — the actual replay
// defense; see handleQueryEvent. Well under the 15-minute NIP-40 expiration
// tag both sides set, so this never rejects a legitimately fresh query.
const FRESHNESS_WINDOW_SECONDS = 300;

// How often to poll relay connection state for the UP/DOWN log — purely for
// operator visibility, not what drives reconnection (nostr-tools does that
// itself once enableReconnect is on, on its own backoff schedule below).
// Deliberately tighter than the reconnect backoff's own first step (10s) so
// a typical blip is actually caught and logged, not silently missed between
// polls.
const CONNECTION_WATCHDOG_MS = 5000;

export function startBridge(config, deps) {
  // enableReconnect is the actual fix for a real production incident: without
  // it, nostr-tools' relay client gives up permanently after any hard close
  // (relay restart, network blip, idle timeout) instead of retrying — and
  // once that was the only open handle left, the whole process exited
  // cleanly (no crash, no error) with no further sign of life. Confirmed
  // against the library's source: reconnect is opt-in, backed by an
  // indefinite capped-backoff retry loop (10s,10s,10s,20s,20s,30s,60s,...)
  // once enabled, and re-fires the existing subscription (bumping `since` to
  // just past the last event seen) on every successful reconnect.
  const pool = new SimplePool({ enableReconnect: true });
  const { relays, identity, trust, kinds, expirationSeconds } = config;
  const seenEventIds = new Set();
  const lastKnownConnected = new Map();

  function isTrusted(pubkey) {
    return trust.mode === "open" || trust.trustedPubkeys.has(pubkey);
  }

  async function buildReply(query, envelopeBody) {
    const envelope = { v: PROTOCOL_VERSION, id: query.id, ...envelopeBody };
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content, "utf8") <= REPLY_PLAINTEXT_BUDGET) {
      return content;
    }

    // A result too large to fit gets an honest error, never a silently
    // truncated ok:true — a caller summing e.g. UTXO values for a balance
    // has no way to tell a truncated array from a complete one, so shrinking
    // it and still reporting success risks silently under-reporting funds.
    return JSON.stringify({
      v: PROTOCOL_VERSION,
      id: query.id,
      ok: false,
      error: "Result too large to deliver over Nostr in one reply",
    });
  }

  async function handleQueryEvent(event) {
    // Real replay defense: reject anything outside a tight freshness window,
    // regardless of the dedup cache below. Matters most in "allowlist" mode —
    // without this, a relay that doesn't honor the NIP-40 expiration tag (or
    // one an attacker controls) could replay an old *trusted* client's signed
    // event well after the dedup cache below has cycled and forgotten it,
    // getting a privileged command reprocessed without the trusted party's
    // key. event.created_at is available unencrypted, so this is checked
    // before spending any time on decryption.
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - event.created_at) > FRESHNESS_WINDOW_SECONDS) {
      logDropped({ pubkey: event.pubkey, reason: "stale event (outside freshness window)" });
      return;
    }

    if (seenEventIds.has(event.id)) return;
    seenEventIds.add(event.id);
    if (seenEventIds.size > 10000) {
      // cheap de-dup for normal relay-reconnect redelivery within the
      // freshness window above; not itself the replay-security boundary
      seenEventIds.clear();
    }

    if (!isTrusted(event.pubkey)) {
      logDropped({ pubkey: event.pubkey, reason: "untrusted pubkey" });
      return; // silent drop (no reply), matches the config protocol
    }

    const conversationKey = nip44.getConversationKey(identity.secretKey, event.pubkey);

    let plaintext;
    try {
      plaintext = nip44.decrypt(event.content, conversationKey);
    } catch {
      logDropped({ pubkey: event.pubkey, reason: "undecryptable content" });
      return;
    }

    let query;
    try {
      query = JSON.parse(plaintext);
    } catch {
      logDropped({ pubkey: event.pubkey, reason: "content is not valid JSON" });
      return;
    }

    if (typeof query.method !== "string" || typeof query.id !== "string") {
      logDropped({ pubkey: event.pubkey, reason: "not a valid query envelope" });
      return;
    }

    logIncoming({ id: query.id, method: query.method, pubkey: event.pubkey });
    const t0 = Date.now();
    const fulcrumMsBefore = deps.fulcrum?.busyTimer?.totalBusyMs ?? 0;
    const coreMsBefore = deps.bitcoinRpc?.busyTimer?.totalBusyMs ?? 0;

    let ok = false;
    let errorMessage;
    let replyContent;

    const queryVersion = query.v ?? PROTOCOL_VERSION;
    if (queryVersion !== PROTOCOL_VERSION) {
      errorMessage = `Unsupported protocol version: ${queryVersion}`;
      replyContent = await buildReply(query, { ok: false, error: errorMessage });
    } else {
      const handler = methods[query.method];
      if (!handler) {
        errorMessage = "Unknown method";
        replyContent = await buildReply(query, { ok: false, error: errorMessage });
      } else {
        try {
          const result = await handler(deps, query.params ?? {});
          ok = true;
          replyContent = await buildReply(query, { ok: true, result });
        } catch (err) {
          errorMessage = err.message;
          replyContent = await buildReply(query, { ok: false, error: errorMessage });
        }
      }
    }
    const backendMs = Date.now() - t0;
    const fulcrumMs = (deps.fulcrum?.busyTimer?.totalBusyMs ?? 0) - fulcrumMsBefore;
    const coreMs = (deps.bitcoinRpc?.busyTimer?.totalBusyMs ?? 0) - coreMsBefore;

    let encryptedContent;
    try {
      encryptedContent = nip44.encrypt(replyContent, conversationKey);
    } catch (err) {
      ok = false;
      errorMessage = `Response too large to encrypt (${err.message})`;
      const fallback = await buildReply(query, { ok: false, error: errorMessage });
      encryptedContent = nip44.encrypt(fallback, conversationKey);
    }

    const now = Math.floor(Date.now() / 1000);
    const replyTemplate = {
      kind: kinds.reply,
      created_at: now,
      tags: [
        ["p", event.pubkey],
        ["e", event.id],
        ["expiration", String(now + expirationSeconds)],
      ],
      content: encryptedContent,
    };
    const signedReply = finalizeEvent(replyTemplate, identity.secretKey);

    const publishStart = Date.now();
    const results = await Promise.allSettled(pool.publish(relays, signedReply));
    const publishMs = Date.now() - publishStart;
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === results.length) {
      ok = false;
      errorMessage = errorMessage ?? "failed to publish reply to any relay";
      console.error(
        `[bridge] failed to publish reply for query ${query.id} to any relay:`,
        failures.map((f) => f.reason),
      );
    }

    logResult({
      id: query.id,
      method: query.method,
      pubkey: event.pubkey,
      ok,
      fulcrumMs,
      coreMs,
      backendMs,
      publishMs,
      totalMs: Date.now() - t0,
      error: errorMessage,
    });
  }

  const since = Math.floor(Date.now() / 1000);
  const sub = pool.subscribeMany(
    relays,
    { kinds: [kinds.query], "#p": [identity.pubkeyHex], since },
    {
      onevent: (event) => {
        handleQueryEvent(event).catch((err) => {
          console.error("[bridge] unhandled error processing query event:", err);
        });
      },
      onclose: (reasons) => {
        // With enableReconnect on, a transient hard-close (relay restart,
        // network blip) is handled silently in the background by the retry
        // loop above and never reaches here — this only fires for a
        // deliberate stop() or a genuinely unrecoverable close, so it stays
        // a real signal instead of routine noise.
        console.warn("[bridge] subscription closed:", reasons);
      },
    },
  );

  // Pure observability — reconnection itself is handled entirely by
  // enableReconnect above; this only makes state transitions visible in the
  // log, since the library doesn't otherwise surface them anywhere.
  const watchdog = setInterval(() => {
    for (const [url, connected] of pool.listConnectionStatus()) {
      const wasConnected = lastKnownConnected.get(url);
      if (wasConnected === true && connected === false) {
        logConnectionChange({ url, connected: false });
      } else if (wasConnected === false && connected === true) {
        logConnectionChange({ url, connected: true });
      }
      lastKnownConnected.set(url, connected);
    }
  }, CONNECTION_WATCHDOG_MS);

  console.log(
    `[bridge] listening as ${identity.npub} on kind ${kinds.query} across ${relays.length} relay(s): ${relays.join(", ")}`,
  );

  return {
    stop() {
      clearInterval(watchdog);
      sub.close();
      pool.destroy();
    },
  };
}
