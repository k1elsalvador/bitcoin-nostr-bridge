import { loadConfig } from "./config.js";
import { FulcrumClient } from "./fulcrum.js";
import { BitcoinRpcClient } from "./bitcoinRpc.js";
import { startBridge } from "./bridge.js";

const config = loadConfig();

console.log(`[index] identity: ${config.identity.npub} (${config.identity.pubkeyHex})`);
console.log(`[index] trust mode: ${config.trust.mode}`);

const fulcrum = new FulcrumClient(config.fulcrum);
const bitcoinRpc = new BitcoinRpcClient(config.bitcoinCore);

const deps = {
  fulcrum,
  bitcoinRpc,
  network: config.network,
  maxPerResponse: config.utxo.maxPerResponse,
  maxHistoryTxs: config.history.maxTxs,
  xpubGapLimit: config.xpub.gapLimit,
  xpubMaxGapLimit: config.xpub.maxGapLimit,
  maxAddresses: config.xpub.maxAddresses,
  maxBatchAddresses: config.batch.maxAddresses,
  confTargets: config.fee.confTargets,
  estimateMode: config.fee.estimateMode,
  floorSatVb: config.fee.floorSatVb,
};

const bridge = startBridge(config, deps);

function shutdown() {
  console.log("\n[index] shutting down...");
  bridge.stop();
  fulcrum.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
