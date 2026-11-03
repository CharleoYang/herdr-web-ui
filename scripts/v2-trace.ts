/**
 * T-02's three-way reconciliation: every expected operation (E) must be exercised and appear in the
 * proxy's trace, and the trace may hold nothing outside E. `E ⊆ trace ⊆ E` is the point — a sweep
 * that simply omits an operation cannot pass by accident.
 *
 *   bun scripts/v2-trace.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const expected = JSON.parse(readFileSync(join(root, "scripts/v2-route-expected.json"), "utf8")) as { operations: { method: string; path: string; target: string }[] };
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}
const key = (method: string, path: string) => `${method} ${path.split("?")[0]}`;

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-trace-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const trace = join(dist, "trace.jsonl");

const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    if (new URL(request.url).pathname === "/api/machines/events") {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          await Bun.sleep(100);
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("{}", { headers: { "content-type": "application/json", "x-upstream": "v1" } });
  },
});

let child: ReturnType<typeof Bun.spawn> | null = null;
try {
  child = Bun.spawn([BINARY, "--dist", dist, "--upstream", `http://127.0.0.1:${upstream.port}`, "--port", "0", "--trace", trace], { stdout: "pipe", stderr: "pipe" });
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
  check("the gateway starts with tracing on", port > 0, text.slice(0, 100));

  const seen = new Set<string>();
  for (const op of expected.operations) {
    const response = await fetch(`http://127.0.0.1:${port}${op.path}`, { method: op.method });
    await response.text();
    seen.add(key(op.method, op.path));
  }

  const rows = existsSync(trace)
    ? readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; path: string })
    : [];
  const traced = new Set(rows.map((row) => key(row.method, row.path)));
  const missing = [...seen].filter((op) => !traced.has(op));
  const extra = [...traced].filter((op) => !seen.has(op));
  check("every expected operation is in the trace", missing.length === 0, missing.join(", "));
  check("nothing unexpected is traced", extra.length === 0, extra.join(", "));
  check("the local alias is traced with its original spelling", traced.has("GET /api/machines/local/pane/read") && traced.has("POST /api/machines/local/tab/create"));
  check("the SSE route is traced", traced.has("GET /api/machines/events"));
  check("the Portal logout is traced", traced.has("POST /_portal/auth/logout"));
} catch (error) {
  check("the trace sweep runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child?.kill("SIGKILL");
  try { upstream.stop(true); } catch { /* already stopped */ }
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-trace: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-trace: all checks passed");
