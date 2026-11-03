/**
 * T-07's remaining gates: the role is rechecked on every send, keys use the herdr RPC when a socket
 * exists and the pty otherwise, insert skips the settle wait, and secret text never reaches a log.
 *
 *   bun scripts/v2-diff-keys.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const SIDECAR = join(root, "crates/pty-sidecar/target/release/ovis-pty-sidecar");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// fixture herdr: records pane.send_keys and answers ok
const socketDir = mkdtempSync(join(tmpdir(), "ovis-v2-keys-"));
const socketPath = join(socketDir, "herdr.sock");
const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const fixture = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        rpcCalls.push({ method: request.method, params: request.params });
        socket.write(JSON.stringify({ id: request.id, result: { type: "ok" } }) + "\n");
      } catch { /* ignore malformed */ }
    }
  });
});
await new Promise<void>((resolve) => fixture.listen(socketPath, resolve));

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-keys-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");

interface Gateway {
  port: number;
  writes: number[];
  inserts: number[];
  stderr: string[];
  stop: () => void;
}
async function startGateway(herdrSocket?: string): Promise<Gateway> {
  const args = [BINARY, "--dist", dist, "--test-listen", "--port", "0"];
  if (herdrSocket) args.push("--herdr-socket", herdrSocket);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, OVIS_PTY_SIDECAR_BIN: SIDECAR } });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (!text.includes("\n") && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
    if (next === null) continue;
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  void reader.cancel().catch(() => {});
  const port = Number(text.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
  const gateway: Gateway = { port, writes: [], inserts: [], stderr: [], stop: () => child.kill("SIGKILL") };
  const stderrReader = child.stderr.getReader();
  void (async () => {
    let pending = "";
    while (true) {
      const next = await stderrReader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        gateway.stderr.push(line);
        const input = line.match(/^input-write (\d+)/);
        if (input) gateway.writes.push(Number(input[1]));
        const insert = line.match(/^insert-write (\d+)/);
        if (insert) gateway.inserts.push(Number(insert[1]));
      }
    }
  })();
  return gateway;
}

interface Session {
  ws: WebSocket;
  echoes: string[];
  errors: string[];
  opened: Promise<void>;
}
function openSession(port: number, paneId?: string): Session {
  const query = paneId ? `&pane_id=${paneId}` : "";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/test/pty?cmd=/bin/cat${query}`);
  ws.binaryType = "arraybuffer";
  const echoes: string[] = [];
  const errors: string[] = [];
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => { resolveOpen = resolve; });
  ws.onopen = () => resolveOpen();
  // never hang a gate on a refused upgrade: the assertions below then fail with evidence
  setTimeout(() => resolveOpen(), 3_000);
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      echoes.push(Buffer.from(event.data.slice(8)).toString());
      const view = new DataView(event.data);
      ws.send(`ack:${Number(view.getBigUint64(0, true)) + event.data.byteLength - 8}`);
    } else if (typeof event.data === "string" && event.data.startsWith("error:")) {
      errors.push(event.data);
    }
  };
  return { ws, echoes, errors, opened };
}
async function waitFor(test: () => boolean, budget = 3_000): Promise<boolean> {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    if (test()) return true;
    await delay(20);
  }
  return test();
}

const withSocket = await startGateway(socketPath);
check("the gateway with a herdr socket starts", withSocket.port > 0);
try {
  {
    const session = openSession(withSocket.port);
    await session.opened;
    session.ws.send("role:viewer");
    await delay(50);
    session.ws.send("input:nope");
    await waitFor(() => session.errors.includes("error:role"));
    await delay(150);
    check("a viewer's input is refused with error:role", session.errors.includes("error:role"));
    check("a viewer's input never reaches the pty", !session.echoes.join("").includes("nope"));
    check("a refused input is never written", withSocket.writes.length === 0);
    session.ws.close();
  }
  {
    const session = openSession(withSocket.port, "w1:p1");
    await session.opened;
    session.ws.send('keys:["Enter"]');
    await waitFor(() => rpcCalls.length > 0);
    check("keys go through pane.send_keys", rpcCalls[0]?.method === "pane.send_keys", JSON.stringify(rpcCalls[0] ?? {}));
    check("the pane id and keys reach herdr", rpcCalls[0]?.params?.pane_id === "w1:p1" && JSON.stringify(rpcCalls[0]?.params?.keys) === '["Enter"]');
    session.ws.close();
  }
  {
    const session = openSession(withSocket.port, "w1:p1");
    await session.opened;
    const before = rpcCalls.length;
    session.ws.send("secret:hunter2");
    await waitFor(() => rpcCalls.length > before);
    await delay(150);
    const call = rpcCalls[before];
    check("a mirrored secret goes over pane.send_text", call?.method === "pane.send_text" && call?.params?.text === "hunter2", JSON.stringify(call ?? {}));
    check("a mirrored secret is not written to the local pty", !session.echoes.join("").includes("hunter2"));
    check("secret text never reaches the gateway log", !withSocket.stderr.join("\n").includes("hunter2"));
    session.ws.close();
  }
  {
    const session = openSession(withSocket.port);
    await session.opened;
    for (let index = 0; index < 5; index += 1) session.ws.send(`insert:fast${index}`);
    await waitFor(() => withSocket.inserts.length >= 5);
    const span = withSocket.inserts.length >= 5 ? withSocket.inserts[4] - withSocket.inserts[0] : 9999;
    check("inserts skip the settle wait", withSocket.inserts.length >= 5 && span < 200, `${span} ms for five inserts`);
    session.ws.close();
  }
} finally {
  withSocket.stop();
}

const withoutSocket = await startGateway();
check("the gateway without a herdr socket starts", withoutSocket.port > 0);
try {
  const session = openSession(withoutSocket.port);
  await session.opened;
  session.ws.send('keys:["a"]');
  await waitFor(() => session.echoes.join("").includes("a"));
  check("with no herdr socket, keys fall back to the pty", session.echoes.join("").includes("a"));
  session.ws.send("secret:localsecret");
  await waitFor(() => session.echoes.join("").includes("localsecret"));
  check("with no herdr socket, a secret is written to the pty", session.echoes.join("").includes("localsecret"));
  check("a local secret never reaches the gateway log", !withoutSocket.stderr.join("\n").includes("localsecret"));
  session.ws.close();
} finally {
  withoutSocket.stop();
  fixture.close();
  rmSync(dist, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-keys: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-keys: all checks passed");
