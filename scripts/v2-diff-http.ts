/**
 * T-02's gate: the proxy must forward byte for byte, stream SSE instead of buffering it, and fail
 * honestly when v1 is gone. Owns its upstream and its fixture; never touches a real Ovis server.
 *
 *   bun scripts/v2-diff-http.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-diff-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");

// A stand-in for v1: a few routes with shapes that a proxy gets wrong in different ways.
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "x-upstream": "v1" } });
    }
    if (url.pathname === "/api/echo") {
      return new Response(JSON.stringify({ method: request.method, body: "pong" }), {
        headers: { "content-type": request.headers.get("content-type") ?? "text/plain", "x-upstream": "v1" },
      });
    }
    if (url.pathname === "/api/error") {
      return new Response("teapot\n", { status: 418, headers: { "x-upstream": "v1" } });
    }
    if (url.pathname === "/api/sse") {
      const stream = new ReadableStream({
        async start(controller) {
          for (const index of [1, 2, 3]) {
            controller.enqueue(new TextEncoder().encode(`data: chunk-${index}\n\n`));
            await Bun.sleep(150);
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "x-upstream": "v1" } });
    }
    return new Response("upstream 404\n", { status: 404 });
  },
});
const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
console.log(`fixture upstream on ${upstreamUrl}`);

let child: ReturnType<typeof Bun.spawn> | null = null;
try {
  child = Bun.spawn([BINARY, "--dist", dist, "--upstream", upstreamUrl, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
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
  check("the gateway prints its port", port > 0, text.slice(0, 120));
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/health`);
  check("health keeps the status", health.status === 200, String(health.status));
  check("health forwards v1's header", health.headers.get("x-upstream") === "v1", health.headers.get("x-upstream") ?? "");
  check("health body is byte for byte", (await health.text()) === JSON.stringify({ ok: true }));

  const echo = await fetch(`${base}/api/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
  const echoed = await echo.json() as { method: string; body: string };
  check("the method is forwarded", echoed.method === "POST", echoed.method);
  check("the content type is forwarded", echo.headers.get("content-type") === "application/json", echo.headers.get("content-type") ?? "");

  // a buffered proxy delivers all three chunks at once; a streaming one spaces them out
  const sse = await fetch(`${base}/api/sse`);
  const arrivals: number[] = [];
  const sseReader = sse.body?.getReader();
  const decoderSse = new TextDecoder();
  let received = "";
  const started = Date.now();
  while (sseReader !== undefined) {
    const next = await sseReader.read();
    if (next.done) break;
    received += decoderSse.decode(next.value, { stream: true });
    arrivals.push(Date.now() - started);
  }
  check("SSE delivers every chunk", [1, 2, 3].every((n) => received.includes(`chunk-${n}`)), received.replace(/\n/g, "|"));
  check("SSE is streamed, not buffered", arrivals.length >= 2 && arrivals[arrivals.length - 1]! - arrivals[0]! >= 200, `arrivals ${arrivals.join(",")} ms`);

  const error = await fetch(`${base}/api/error`);
  check("an upstream error status is preserved", error.status === 418, String(error.status));
  await error.text();

  const index = await fetch(`${base}/`);
  check("the static fixture is still served locally", index.status === 200, String(index.status));
  await index.text();

  upstream.stop(true);
  await Bun.sleep(150);
  const down = await fetch(`${base}/api/health`);
  check("an unreachable upstream is a 502, not a fabricated answer", down.status === 502, String(down.status));
  await down.text();
} catch (error) {
  check("the proxy runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child?.kill("SIGKILL");
  try { upstream.stop(true); } catch { /* already stopped */ }
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-http: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-http: all checks passed");
