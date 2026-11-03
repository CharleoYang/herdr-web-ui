/**
 * T-07's gate: typed input keeps its order, ordinary typing settles 40 ms, a trailing ESC 300 ms,
 * and input after detach is dropped. The gaps are measured on the gateway's own write timestamps
 * (stderr, test-only), because a PTY echo's arrival time would understate the write gap.
 *
 *   bun scripts/v2-diff-input.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const SIDECAR = join(root, "crates/pty-sidecar/target/release/ovis-pty-sidecar");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-input-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const child = Bun.spawn([BINARY, "--dist", dist, "--test-listen", "--port", "0"], {
  stdout: "pipe", stderr: "pipe",
  env: { ...process.env, OVIS_PTY_SIDECAR_BIN: SIDECAR },
});
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
check("the test listener starts", port > 0, text.slice(0, 80));

// the gateway's own write timestamps: the only clock that measures the invariant itself
const writes: number[] = [];
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
      const match = line.match(/^input-write (\d+)/);
      if (match) writes.push(Number(match[1]));
    }
  }
})();

interface Echo { at: number; text: string }
function openCat(): { ws: WebSocket; echoes: Echo[]; opened: Promise<void> } {
  const echoes: Echo[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/test/pty?cmd=/bin/cat`);
  ws.binaryType = "arraybuffer";
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => { resolveOpen = resolve; });
  ws.onopen = () => resolveOpen();
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const payload = Buffer.from(event.data.slice(8));
      echoes.push({ at: performance.now(), text: payload.toString() });
      const view = new DataView(event.data);
      const end = Number(view.getBigUint64(0, true)) + event.data.byteLength - 8;
      ws.send(`ack:${end}`);
    }
  };
  return { ws, echoes, opened };
}
function find(echoes: Echo[], needle: string): Echo | undefined {
  return echoes.find((echo) => echo.text.includes(needle));
}
async function settle(echoes: Echo[], needle: string, budget = 3_000): Promise<Echo | undefined> {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const found = find(echoes, needle);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}
async function waitWrites(count: number, budget = 4_000): Promise<void> {
  const end = Date.now() + budget;
  while (writes.length < count && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

try {
  {
    const session = openCat();
    await session.opened;
    session.ws.send("input:abc");
    session.ws.send("input:def");
    await waitWrites(2);
    const first = await settle(session.echoes, "abc");
    const second = await settle(session.echoes, "def");
    check("both writes reach the pty", first !== undefined && second !== undefined);
    check("the order is preserved", first !== undefined && second !== undefined && second!.at >= first!.at);
    const gap = writes[1] - writes[0];
    check("ordinary typing settles 40 ms", writes.length >= 2 && gap >= 40, `${gap} ms between writes`);
    session.ws.close();
  }
  {
    const before = writes.length;
    const session = openCat();
    await session.opened;
    session.ws.send("input:xyz\u001b");
    session.ws.send("input:next");
    await waitWrites(before + 2);
    const gap = writes[before + 1] - writes[before];
    check("a trailing ESC settles 300 ms", writes.length >= before + 2 && gap >= 300, `${gap} ms between writes`);
    session.ws.close();
  }
  {
    const session = openCat();
    await session.opened;
    session.ws.send("detach");
    session.ws.send("input:after-detach");
    await new Promise((resolve) => setTimeout(resolve, 400));
    check("input after detach is dropped", find(session.echoes, "after-detach") === undefined);
    session.ws.close();
  }
} catch (error) {
  check("the input gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill("SIGKILL");
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-input: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-input: all checks passed");
