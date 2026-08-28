import { handleAddressStats } from "./addressStats.js";
import { handleAddressUtxo } from "./addressUtxo.js";
import { handleAddressStatsBatch } from "./addressStatsBatch.js";
import { handleAddressUtxoBatch } from "./addressUtxoBatch.js";
import { handleFeeRecommended } from "./feeRecommended.js";
import { handleTxBroadcast } from "./txBroadcast.js";
import { handleTxStatus } from "./txStatus.js";
import { handleXpubBalance } from "./xpubBalance.js";

export const methods = {
  "chain.address.stats": handleAddressStats,
  "chain.address.utxo": handleAddressUtxo,
  "chain.address.stats.batch": handleAddressStatsBatch,
  "chain.address.utxo.batch": handleAddressUtxoBatch,
  "chain.fee.recommended": handleFeeRecommended,
  "chain.tx.broadcast": handleTxBroadcast,
  "chain.tx.status": handleTxStatus,
  "chain.xpub.balance": handleXpubBalance,
};
