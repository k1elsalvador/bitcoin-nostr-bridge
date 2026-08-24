const toSatVb = (btcPerKvb) => Math.ceil((btcPerKvb * 1e8) / 1000);

export async function getFeeRecommendation({ bitcoinRpc, confTargets, estimateMode, floorSatVb }) {
  const estimate = async (target) => {
    const res = await bitcoinRpc.estimateSmartFee(target, estimateMode);
    if (res.errors?.length || res.feerate == null) return null;
    return toSatVb(res.feerate);
  };

  const [fastestFee, halfHourFee, hourFee, economyFee] = await Promise.all([
    estimate(confTargets.fastestFee),
    estimate(confTargets.halfHourFee),
    estimate(confTargets.hourFee),
    estimate(confTargets.economyFee),
  ]);

  let minimumFee = floorSatVb;
  try {
    const info = await bitcoinRpc.getMempoolInfo();
    if (info.mempoolminfee != null) {
      minimumFee = Math.max(floorSatVb, toSatVb(info.mempoolminfee));
    }
  } catch {
    // fall back to configured floor
  }

  // A missing tier (estimatesmartfee often can't answer a short conf-target
  // right after startup or on a quiet mempool) must NOT fall back to
  // minimumFee directly — that previously dragged every *other* tier down to
  // the floor too via the monotonic clamp below, even when e.g. hourFee had
  // a real, much higher estimate. Fall back to the highest real estimate we
  // did get instead, so a missing tier never under-reports what we actually
  // know the network needs; only fall back to the floor if no tier estimated
  // successfully at all.
  const raw = [fastestFee, halfHourFee, hourFee, economyFee];
  const knownEstimates = raw.filter((v) => v != null);
  const bestKnownEstimate = knownEstimates.length ? Math.max(...knownEstimates) : minimumFee;
  const fees = raw.map((v) => v ?? bestKnownEstimate);

  // Estimates can be noisy when the mempool is thin; keep the tiers
  // non-increasing (fastest >= ... >= economy) so the response is sane even
  // when some targets fell back to bestKnownEstimate and others didn't.
  for (let i = 1; i < fees.length; i++) {
    fees[i] = Math.min(fees[i], fees[i - 1]);
  }

  const [fastest, halfHour, hour, economy] = fees;
  return {
    fastestFee: fastest,
    halfHourFee: halfHour,
    hourFee: hour,
    economyFee: economy,
    minimumFee,
  };
}
