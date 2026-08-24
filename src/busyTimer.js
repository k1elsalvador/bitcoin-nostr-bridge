/**
 * Tracks wall-clock time during which at least one request is in flight —
 * the union of possibly-overlapping [start,end] intervals, not a naive sum
 * of each request's own duration (which double-counts overlapping time when
 * requests run concurrently, e.g. a Promise.all of many backend calls).
 * O(1) per request: only tracks whether the "busy" window is currently open.
 */
export class BusyTimer {
  constructor() {
    this.activeCount = 0;
    this.busyStart = 0;
    this.totalBusyMs = 0;
  }

  start() {
    if (this.activeCount === 0) this.busyStart = Date.now();
    this.activeCount += 1;
  }

  end() {
    this.activeCount -= 1;
    if (this.activeCount === 0) {
      this.totalBusyMs += Date.now() - this.busyStart;
    }
  }
}
