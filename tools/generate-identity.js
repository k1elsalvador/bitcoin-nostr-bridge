#!/usr/bin/env node
/**
 * Generates a fresh Nostr keypair for a new bridge deployment.
 *
 * Every self-hosted bridge needs its OWN identity — reusing the nsec from
 * this repo's config.example.json (a specific test key from the original
 * deployment) would mean every self-hoster's bridge answers to the exact
 * same npub, colliding with each other on any relay they share. Run this
 * once per deployment and paste the nsec into your own config.json.
 *
 * Usage: node tools/generate-identity.js
 */
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

const secretKey = generateSecretKey();
const pubkeyHex = getPublicKey(secretKey);
const nsec = nip19.nsecEncode(secretKey);
const npub = nip19.npubEncode(pubkeyHex);

console.log("New bridge identity generated:\n");
console.log(`  nsec (secret, put in config.json's identity.nsec): ${nsec}`);
console.log(`  npub (public, share this with kiosk operators):    ${npub}`);
console.log(`  pubkey hex:                                        ${pubkeyHex}`);
console.log(
  "\nThis key is not shown again — copy the nsec into config.json now. Treat it like any" +
    " other private key: it doesn't hold funds, but anyone with it can impersonate this bridge.",
);
