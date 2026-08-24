import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import * as btc from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { BusyTimer } from "./busyTimer.js";

btc.initEccLib(ecc);

const NETWORKS = {
  bitcoin: btc.networks.bitcoin,
  testnet: btc.networks.testnet,
  regtest: btc.networks.regtest,
};

/** Electrum protocol scripthash: byte-reversed sha256(scriptPubKey), hex. */
export function addressToScripthash(address, networkName = "bitcoin") {
  const network = NETWORKS[networkName];
  if (!network) throw new Error(`Unknown network: ${networkName}`);
  const script = btc.address.toOutputScript(address, network);
  return scriptToScripthash(script);
}

/** Same scripthash definition, from a raw scriptPubKey (Buffer or hex string). */
export function scriptToScripthash(script) {
  const buf = Buffer.isBuffer(script) ? script : Buffer.from(script, "hex");
  const hash = crypto.createHash("sha256").update(buf).digest();
  hash.reverse();
  return hash.toString("hex");
}

/**
 * Minimal Electrum protocol client (newline-delimited JSON-RPC over TCP/TLS).
 * Persistent connection with lazy reconnect: a dropped socket rejects all
 * in-flight requests, and the next request re-establishes the connection.
 */
export class FulcrumClient {
  constructor({ host, port, tls: useTls = true, tlsRejectUnauthorized = true }) {
    this.host = host;
    this.port = port;
    this.useTls = useTls;
    this.tlsRejectUnauthorized = tlsRejectUnauthorized;
    if (useTls && !tlsRejectUnauthorized) {
      console.warn(
        "[fulcrum] TLS certificate verification is DISABLED (fulcrum.tlsRejectUnauthorized: false) " +
          "— the connection to Fulcrum is vulnerable to on-path tampering. Only use this for a " +
          "self-signed cert you've verified out-of-band, on a network you trust.",
      );
    }
    this.socket = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.connectPromise = null;
    this.busyTimer = new BusyTimer(); // wall-clock time waiting on Fulcrum, for per-request timing logs
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
        this.request("server.version", ["bitcoin-nostr-bridge/0.1.0", "1.4"]).catch(() => {
          // best-effort handshake; not fatal if the server skips it
        });
      };
      const onError = (err) => {
        this._teardown(err);
        reject(err);
      };
      const socket = this.useTls
        ? tls.connect({ ...opts, rejectUnauthorized: this.tlsRejectUnauthorized }, onConnect)
        : net.connect(opts, onConnect);
      socket.setEncoding("utf8");
      socket.setKeepAlive(true);
      socket.once("error", onError);
      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("close", () => this._teardown(new Error("Fulcrum connection closed")));
      this.socket = socket;
    });
    return this.connectPromise;
  }

  _teardown(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.socket = null;
    this.connectPromise = null;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  async request(method, params = []) {
    await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    this.busyTimer.start();
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.socket.write(payload, (err) => {
          if (err) {
            this.pending.delete(id);
            reject(err);
          }
        });
      });
    } finally {
      this.busyTimer.end();
    }
  }

  /** [{tx_hash, height}], height <=0 means unconfirmed. */
  getHistory(scripthash) {
    return this.request("blockchain.scripthash.get_history", [scripthash]);
  }

  /** [{tx_hash, tx_pos, height, value}] */
  listUnspent(scripthash) {
    return this.request("blockchain.scripthash.listunspent", [scripthash]);
  }

  getTransaction(txid, verbose = true) {
    return this.request("blockchain.transaction.get", [txid, verbose]);
  }

  close() {
    if (this.socket) this.socket.destroy();
    this._teardown(new Error("Fulcrum client closed"));
  }
}
