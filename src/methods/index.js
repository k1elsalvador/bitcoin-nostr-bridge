import { handleAddressStats } from "./addressStats.js";
import { handleAddressUtxo } from "./addressUtxo.js";
import { handleFeeRecommended } from "./feeRecommended.js";
import { handleTxBroadcast } from "./txBroadcast.js";
import { handleTxStatus } from "./txStatus.js";
import { handleXpubBalance } from "./xpubBalance.js";

export const methods = {
  "chain.address.stats": handleAddressStats,
  "chain.address.utxo": handleAddressUtxo,
  "chain.fee.recommended": handleFeeRecommended,
  "chain.tx.broadcast": handleTxBroadcast,
  "chain.tx.status": handleTxStatus,
  "chain.xpub.balance": handleXpubBalance,
};
