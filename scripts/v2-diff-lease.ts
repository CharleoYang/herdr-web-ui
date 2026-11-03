/**
 * v1's rehold rule (server/core/pending.ts:157-160): a fault re-holds queued and non-terminal held
 * items, never a target-changed/launch-gone hold, never something in flight or already done.
 *
 *   bun scripts/v2-diff-lease.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-lease-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const work = mkdtempSync(join(tmpdir(), "ovis-v2-lease-state-"));
const child = Bun.spawn([BINARY, "--dist", dist, "--port", "0", "--state", join(work, "state.json")], {
  stdout: "pipe", stderr: "pipe",
});
const reader = child.stdout.getReader();
const decoder = new TextDecoder();
let banner = "";
const deadline = Date.now() + 5_000;
while (!banner.includes("\n") && Date.now() < deadline) {
  const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
  if (next === null) continue;
  if (next.done) break;
  banner += decoder.decode(next.value, { stream: true });
}
void reader.cancel().catch(() => {});
const port = Number(banner.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
check("the gateway starts", port > 0);

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}
async function submit(pane: string, text: string): Promise<string> {
  return (await api("POST", "/api/pending/submit", { pane_id: pane, text })).id;
}
async function byId(id: string): Promise<any> {
  const list = await api("GET", "/api/pending");
  return list.pending.find((item: any) => item.id === id);
}

try {
  const a = await submit("w1:p1", "A");
  const b = await submit("w1:p1", "B");
  const c = await submit("w1:p1", "C");
  const d = await submit("w1:p1", "D");
  await api("POST", "/api/pending/resolve", { id: b, outcome: "held", code: "pending_target_changed" });
  await api("POST", "/api/pending/resolve", { id: c, outcome: "sending" });
  await api("POST", "/api/pending/resolve", { id: d, outcome: "done" });

  const first = await api("POST", "/api/pending/rehold", { fault: "disconnected" });
  check("only the queued item is re-held", first.reheld === 1, JSON.stringify(first));
  check("queued becomes held with the fault", (await byId(a)).state === "held" && (await byId(a)).error === "disconnected", JSON.stringify(await byId(a)));
  check("a target-changed hold keeps its own code", (await byId(b)).state === "held" && (await byId(b)).error === "pending_target_changed", JSON.stringify(await byId(b)));
  check("an in-flight item is not re-held", (await byId(c)).state === "sending");
  check("a done item is not re-held", (await byId(d)).state === "done");

  const e = await submit("w1:p1", "E");
  await api("POST", "/api/pending/resolve", { id: e, outcome: "held", code: "input_not_ready" });
  const second = await api("POST", "/api/pending/rehold", { fault: "read_only" });
  check("non-terminal holds are re-held again", second.reheld === 2, JSON.stringify(second));
  check("the new fault replaces a non-terminal hold's code", (await byId(e)).error === "read_only");

  const f = await submit("w1:p2", "F");
  const scoped = await api("POST", "/api/pending/rehold", { fault: "disconnected", pane_id: "w1:p2" });
  check("a pane-scoped rehold touches only that pane", scoped.reheld === 1, JSON.stringify(scoped));
  check("the scoped item is held", (await byId(f)).state === "held");
  check("other panes keep their state", (await byId(e)).error === "read_only");
} catch (error) {
  check("the lease gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill("SIGKILL");
  rmSync(dist, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-lease: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-lease: all checks passed");
