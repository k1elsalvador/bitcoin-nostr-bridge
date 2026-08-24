import { BusyTimer } from "./busyTimer.js";

/** Minimal Bitcoin Core JSON-RPC client (HTTP, basic auth). */
export class BitcoinRpcClient {
  constructor({ host, port, user, password }) {
    this.url = `http://${host}:${port}/`;
    this.authHeader = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
    this.nextId = 1;
    this.busyTimer = new BusyTimer(); // wall-clock time waiting on Core RPC, for per-request timing logs
  }

  async call(method, params = []) {
    const id = this.nextId++;
    this.busyTimer.start();
    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader,
        },
        body: JSON.stringify({ jsonrpc: "1.0", id, method, params }),
      });
    } finally {
      this.busyTimer.end();
    }

    if (!res.ok && res.status !== 500) {
      // Core returns 500 on RPC-level errors but still sends a valid JSON-RPC error body
      throw new Error(`Bitcoin Core RPC HTTP ${res.status}: ${res.statusText}`);
    }

    const body = await res.json();
    if (body.error) {
      throw new Error(`Bitcoin Core RPC error (${method}): ${body.error.message}`);
    }
    return body.result;
  }

  estimateSmartFee(confTarget, estimateMode) {
    return this.call("estimatesmartfee", [confTarget, estimateMode]);
  }

  getMempoolInfo() {
    return this.call("getmempoolinfo");
  }

  sendRawTransaction(hex) {
    return this.call("sendrawtransaction", [hex]);
  }

  getRawTransaction(txid, verbose = true) {
    return this.call("getrawtransaction", [txid, verbose]);
  }

  getBlockHash(height) {
    return this.call("getblockhash", [height]);
  }

  getBlockHeader(blockhash) {
    return this.call("getblockheader", [blockhash]);
  }
}
