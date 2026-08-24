import { getFeeRecommendation } from "../chain/feeRecommended.js";

export async function handleFeeRecommended(deps) {
  return getFeeRecommendation(deps);
}
