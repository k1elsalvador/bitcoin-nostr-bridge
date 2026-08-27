// Dependency-free structured live-request logger. One line per event, safe
// to `tail -f` (Linux) or `Get-Content -Wait` (Windows) regardless of
// whether stdout is a TTY (colors are skipped automatically when piped to a
// file, so log files stay clean of ANSI codes).
const isTTY = Boolean(process.stdout.isTTY);

const CODES = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

function paint(code, text) {
  return isTTY ? `${code}${text}${CODES.reset}` : text;
}

function timestamp() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function shortId(id) {
  return (id ?? "").slice(0, 8).padEnd(8);
}

function shortHex(hex) {
  return (hex ?? "").slice(0, 10).padEnd(10);
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

export function logIncoming({ id, method, pubkey }) {
  console.log(
    `${timestamp()} ${paint(CODES.cyan, "IN ")} ${shortId(id)} ${method.padEnd(24)} from ${shortHex(pubkey)}`,
  );
}

export function logDropped({ pubkey, reason }) {
  console.log(`${timestamp()} ${paint(CODES.dim, "DROP")} ${" ".repeat(9)} from ${shortHex(pubkey)} ${paint(CODES.dim, reason)}`);
}

// Only called on an actual state transition (never on the initial connect,
// never repeated while already in that state) — see bridge.js's connection
// watchdog. A relay hard-close is otherwise invisible: nostr-tools retries
// silently in the background once enableReconnect is on, so without this
// there'd be no trace in the log that anything happened at all.
export function logConnectionChange({ url, connected }) {
  const status = connected
    ? paint(CODES.green, "UP  ")
    : paint(CODES.yellow, "DOWN");
  const note = connected ? "reconnected" : "disconnected — auto-reconnecting in the background";
  console.log(`${timestamp()} ${status} ${" ".repeat(9)} relay ${url} ${note}`);
}

// fulcrumMs/coreMs are wall-clock time this request spent with at least one
// Fulcrum/Core call in flight (concurrent calls overlap rather than stack,
// so this never exceeds backendMs) — the real answer to "how much of this
// request's time was Electrum/Core actually the bottleneck".
export function logResult({ id, method, pubkey, ok, fulcrumMs, coreMs, backendMs, publishMs, totalMs, error }) {
  const status = ok ? paint(CODES.green, "OK ") : paint(CODES.red, "ERR");
  const timing = `fulcrum=${fulcrumMs}ms core=${coreMs}ms backend=${backendMs}ms publish=${publishMs}ms total=${totalMs}ms`;
  const suffix = ok ? "" : ` error="${truncate(error, 100)}"`;
  console.log(
    `${timestamp()} ${status} ${shortId(id)} ${method.padEnd(24)} from ${shortHex(pubkey)} ${timing}${suffix}`,
  );
}
