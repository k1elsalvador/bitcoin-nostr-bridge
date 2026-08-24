#!/usr/bin/env node
/**
 * Test bot: queries the real mempool.space REST API for the same five
 * operations this bridge implements, and saves the raw JSON to
 * test/fixtures/*.json. Ground truth for response shapes — run this before
 * (or while) building/changing the chain.* handlers to confirm field names
 * and types haven't drifted from what MiniPlusApp's DTOs expect.
 *
 * Usage: node tools/mempool-probe.js <address> <confirmed-txid>
 * (chain.tx.broadcast is intentionally not probed here — it would require
 * spending real funds; its shape is documented directly in
 * docs/BRIDGE-CONTRACT.md from mempool.space's own API docs instead.)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "test", "fixtures");
mkdirSync(fixturesDir, { recursive: true });

const BASE = "https://mempool.space/api";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function save(name, data) {
  const file = path.join(fixturesDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`  saved -> ${path.relative(process.cwd(), file)}`);
}

async function main() {
  const [address, txid] = process.argv.slice(2);
  if (!address || !txid) {
    console.error("Usage: node tools/mempool-probe.js <address> <confirmed-txid>");
    process.exit(1);
  }

  console.log(`GET /address/${address}`);
  const stats = await getJson(`${BASE}/address/${address}`);
  console.log(JSON.stringify(stats, null, 2));
  save("address-stats", stats);

  console.log(`\nGET /address/${address}/utxo`);
  const utxos = await getJson(`${BASE}/address/${address}/utxo`);
  console.log(JSON.stringify(utxos.slice(0, 3), null, 2), utxos.length > 3 ? `\n...(${utxos.length} total)` : "");
  save("address-utxo", utxos);

  console.log(`\nGET /v1/fees/recommended`);
  const fees = await getJson(`${BASE}/v1/fees/recommended`);
  console.log(JSON.stringify(fees, null, 2));
  save("fees-recommended", fees);

  console.log(`\nGET /tx/${txid}`);
  const tx = await getJson(`${BASE}/tx/${txid}`);
  console.log(JSON.stringify(tx, null, 2));
  save("tx", tx);

  console.log(
    "\nDone. chain.tx.broadcast not probed (would require a real signed tx) — " +
      "its shape (bare txid string response) is documented from mempool.space's own API reference in docs/BRIDGE-CONTRACT.md.",
  );
}

main().catch((err) => {
  console.error("mempool-probe failed:", err.message);
  process.exit(1);
});
