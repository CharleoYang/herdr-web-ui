/**
 * T-06's gate: sidecar bytes arrive in order with offsets, a consumer that never ACKs is closed
 * with 4008 instead of growing memory, and an ACKing consumer keeps flowing.
 *
 *   bun scripts/v2-soak.ts
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

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-pty-dist-"));
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
check("the test listener starts", port > 0, text.slice(0, 100));

interface Frame { offset: bigint; payload: Buffer }
function decode(data: ArrayBuffer): Frame {
  const view = new DataView(data);
  const offset = view.getBigUint64(0, true);
  return { offset, payload: Buffer.from(data.slice(8)) };
}

async function caseOrdered(): Promise<void> {
  const frames: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/test/pty?cmd=printf+hello`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) frames.push(decode(event.data));
    };
    ws.onclose = () => resolve();
    setTimeout(resolve, 4_000);
  });
  ws.close();
  const text = frames.map((frame) => frame.payload.toString()).join("");
  check("the sidecar's bytes arrive", text.includes("hello"), text.slice(0, 40));
  let expected = 0n;
  const ordered = frames.every((frame) => {
    const ok = frame.offset === expected;
    expected += BigInt(frame.payload.length);
    return ok;
  });
  check("offsets are contiguous, never reordered", ordered, frames.map((f) => f.offset.toString()).join(","));
}

async function caseStalled(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/test/pty?cmd=yes+x`);
  ws.binaryType = "arraybuffer";
  let closeCode = 0;
  let bytes = 0;
  const started = Date.now();
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => { if (event.data instanceof ArrayBuffer) bytes += event.data.byteLength; };
    ws.onclose = (event) => { closeCode = event.code; resolve(); };
    setTimeout(resolve, 8_000);
  });
  // never ACKed: the window must close the connection, not keep buffering
  check("a consumer that never ACKs is closed with 4008", closeCode === 4008, `code ${closeCode}, ${bytes} bytes in ${Date.now() - started} ms`);
  const rss = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(child.pid)]).stdout.toString().trim();
  check("the stalled gateway stays small", Number(rss) / 1024 < 50, `${(Number(rss) / 1024).toFixed(1)} MB`);
}

async function caseAcked(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/test/pty?cmd=printf+done`);
  ws.binaryType = "arraybuffer";
  let closeCode = 0;
  let acked = 0;
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = decode(event.data);
        acked = Number(frame.offset + BigInt(frame.payload.length));
        ws.send(`ack:${acked}`);
      }
    };
    ws.onclose = (event) => { closeCode = event.code; resolve(); };
    setTimeout(resolve, 4_000);
  });
  check("an ACKing consumer is not closed with 4008", closeCode !== 4008, `code ${closeCode}`);
}

try {
  await caseOrdered();
  await caseStalled();
  await caseAcked();
} catch (error) {
  check("the PTY gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill("SIGKILL");
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-soak: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-soak: all checks passed");
