#!/usr/bin/env node
/**
 * Fake-kiosk verifier: acts as a MiniPlusApp kiosk would, speaking the exact
 * wire protocol from MiniPlusApp/docs/electrum-nostr-bridge-contract.md —
 * generates an ephemeral test keypair, sends a chain.* Query to the bridge's
 * npub over the configured relays, waits for the correlated Reply, decrypts
 * and prints it. This is the end-to-end verification path since the bridge
 * has no UI of its own.
 *
 * Usage:
 *   node tools/test-client.js <method> [params-json]
 *
 * Examples:
 *   node tools/test-client.js chain.address.stats '{"address":"bc1q..."}'
 *   node tools/test-client.js chain.fee.recommended
 *   node tools/test-client.js chain.tx.status '{"txid":"<64-hex>"}'
 */
import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../src/config.js";

useWebSocketImplementation(WebSocket);

const TIMEOUT_MS = Number(process.env.TEST_CLIENT_TIMEOUT_MS) || 15000;

async function main() {
  const [method, paramsJson] = process.argv.slice(2);
  if (!method) {
    console.error("Usage: node tools/test-client.js <method> [params-json]");
    process.exit(1);
  }
  let params = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch (err) {
      console.error("params-json is not valid JSON:", err.message);
      process.exit(1);
    }
  }

  const config = loadConfig();
  const bridgePubkey = config.identity.pubkeyHex;

  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const conversationKey = nip44.getConversationKey(clientSecretKey, bridgePubkey);

  const queryId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const queryEnvelope = { v: 1, id: queryId, method, params, ts: now };

  const queryTemplate = {
    kind: config.kinds.query,
    created_at: now,
    tags: [
      ["p", bridgePubkey],
      ["expiration", String(now + config.expirationSeconds)],
    ],
    content: nip44.encrypt(JSON.stringify(queryEnvelope), conversationKey),
  };
  const signedQuery = finalizeEvent(queryTemplate, clientSecretKey);

  const pool = new SimplePool();

  console.log(`[test-client] pubkey: ${clientPubkey}`);
  console.log(`[test-client] querying ${config.identity.npub} on kind ${config.kinds.query}`);
  console.log(`[test-client] -> ${method} ${JSON.stringify(params)}`);

  const replyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.close();
      reject(new Error(`Timed out after ${TIMEOUT_MS}ms waiting for a reply`));
    }, TIMEOUT_MS);

    const sub = pool.subscribeMany(
      config.relays,
      { kinds: [config.kinds.reply], "#p": [clientPubkey], since: now },
      {
        onevent: (event) => {
          let plaintext;
          try {
            plaintext = nip44.decrypt(event.content, conversationKey);
          } catch {
            return; // not addressed to us / not from the bridge conversation
          }
          let envelope;
          try {
            envelope = JSON.parse(plaintext);
          } catch {
            return;
          }
          if (envelope.id !== queryId) return; // some other in-flight reply
          clearTimeout(timer);
          sub.close();
          resolve(envelope);
        },
      },
    );
  });

  await Promise.all(pool.publish(config.relays, signedQuery));
  console.log(`[test-client] published query ${queryId}, waiting for reply...`);

  try {
    const reply = await replyPromise;
    console.log(`[test-client] reply:`, JSON.stringify(reply, null, 2));
    process.exitCode = reply.ok ? 0 : 2;
  } catch (err) {
    console.error(`[test-client] ${err.message}`);
    process.exitCode = 1;
  } finally {
    pool.destroy();
  }
}

main();
