/**
 * Spec T-06's guards: Stop cancels queued typing, queued writes flush in order, herdrTyping is an
 * RPC path with no PTY attach requirement, and the role is rechecked on each path.
 *
 *   bun scripts/v2-diff-guards.ts
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

const socketDir = mkdtempSync(join(tmpdir(), "ovis-v2-guards-"));
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

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-guards-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const child = Bun.spawn([BINARY, "--dist", dist, "--test-listen", "--port", "0", "--herdr-socket", socketPath], {
  stdout: "pipe", stderr: "pipe",
  env: { ...process.env, OVIS_PTY_SIDECAR_BIN: SIDECAR },
});
const decoder = new TextDecoder();
let banner = "";
{
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 5_000;
  while (!banner.includes("\n") && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
    if (next === null) continue;
    if (next.done) break;
    banner += decoder.decode(next.value, { stream: true });
  }
  void reader.cancel().catch(() => {});
}
const port = Number(banner.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
check("the gateway starts", port > 0, banner.slice(0, 80));

const writes: number[] = [];
{
  const reader = child.stderr.getReader();
  void (async () => {
    let pending = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const match = line.match(/^input-write (\d+)/);
        if (match) writes.push(Number(match[1]));
      }
    }
  })();
}

interface Session { ws: WebSocket; echoes: string[]; errors: string[]; opened: Promise<void> }
function openSession(paneId = "w1:p1"): Session {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/test/pty?cmd=/bin/cat&pane_id=${paneId}`);
  ws.binaryType = "arraybuffer";
  const echoes: string[] = [];
  const errors: string[] = [];
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => { resolveOpen = resolve; });
  ws.onopen = () => resolveOpen();
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

try {
  {
    const session = openSession();
    await session.opened;
    const before = writes.length;
    session.ws.send("queue:aaa");
    session.ws.send("queue:bbb");
    await delay(150);
    check("queued typing is held before the flush", writes.length === before && !session.echoes.join("").includes("aaa"));
    session.ws.send("flush");
    await waitFor(() => writes.length >= before + 2);
    check("the flush writes both queued items", writes.length >= before + 2, `${writes.length - before} writes`);
    await waitFor(() => session.echoes.join("").includes("bbb"));
    const text = session.echoes.join("");
    check("the queued order is preserved", text.indexOf("aaa") !== -1 && text.indexOf("aaa") < text.indexOf("bbb"));
    session.ws.close();
  }
  {
    const session = openSession();
    await session.opened;
    const before = writes.length;
    session.ws.send("queue:held");
    session.ws.send("stop");
    session.ws.send("flush");
    await delay(250);
    check("Stop drops the queued typing", writes.length === before && !session.echoes.join("").includes("held"));
    session.ws.send("input:blocked");
    await waitFor(() => session.errors.includes("error:stopped"));
    check("input while stopped is refused", session.errors.includes("error:stopped"));
    check("a refused input is never written", writes.length === before);
    session.ws.send("resume");
    session.ws.send("input:ok");
    await waitFor(() => writes.length > before);
    check("resume allows typing again", writes.length > before);
    session.ws.close();
  }
  {
    const session = openSession("w1:p9");
    await session.opened;
    const before = rpcCalls.length;
    const writesBefore = writes.length;
    session.ws.send("herdr:remote-text");
    await waitFor(() => rpcCalls.length > before);
    await delay(150);
    const call = rpcCalls[before];
    check("herdrTyping uses pane.send_text", call?.method === "pane.send_text" && call?.params?.text === "remote-text" && call?.params?.pane_id === "w1:p9", JSON.stringify(call ?? {}));
    check("herdrTyping does not write to the pty", writes.length === writesBefore && !session.echoes.join("").includes("remote-text"));
    session.ws.close();
  }
  {
    const session = openSession();
    await session.opened;
    session.ws.send("role:viewer");
    await delay(50);
    session.ws.send("queue:nope");
    await waitFor(() => session.errors.includes("error:role"));
    check("a viewer cannot queue typing", session.errors.includes("error:role"));
    session.ws.send("herdr:nope");
    await delay(150);
    check("a viewer cannot use herdrTyping", session.errors.filter((error) => error === "error:role").length >= 2);
    session.ws.close();
  }
} catch (error) {
  check("the guard gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill("SIGKILL");
  fixture.close();
  rmSync(dist, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-guards: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-guards: all checks passed");
