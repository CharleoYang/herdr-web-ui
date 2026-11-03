/**
 * T-04b's gate for the native pane reads: parameters are validated here, formats are forwarded,
 * and the answers keep coming after v1 stops.
 *
 *   bun scripts/v2-diff-pane.ts
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

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-pane-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const socketPath = join(dist, "herdr.sock");

const daemon = Bun.listen({
  unix: socketPath,
  socket: {
    data(socket, chunk) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as { id?: string; method?: string; params?: Record<string, unknown> };
        const params = frame.params ?? {};
        switch (frame.method) {
          case "pane.read": {
            socket.write(`${JSON.stringify({ id: frame.id, result: { pane_id: params.pane_id, source: params.source, format: params.format, text: "fixture screen" } })}\n`);
            break;
          }
          case "pane.scroll_info": {
            socket.write(`${JSON.stringify({ id: frame.id, result: { pane_id: params.pane_id, max_offset_from_bottom: 40 } })}\n`);
            break;
          }
          case "pane.scroll": {
            socket.write(`${JSON.stringify({ id: frame.id, result: { pane_id: params.pane_id, offset_from_bottom: params.offset_from_bottom } })}\n`);
            break;
          }
          default: {
            socket.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
          }
        }
      }
    },
  },
});

const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  },
});

let child: ReturnType<typeof Bun.spawn> | null = null;
try {
  child = Bun.spawn([BINARY, "--dist", dist, "--herdr-socket", socketPath, "--upstream", `http://127.0.0.1:${upstream.port}`, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
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
  check("the gateway starts", port > 0, text.slice(0, 100));
  const base = `http://127.0.0.1:${port}`;

  const read = await fetch(`${base}/api/pane/read?pane_id=w:p1`);
  const body = await read.json() as { read?: { pane_id?: string; source?: string; format?: string; text?: string } };
  check("read is 200 with the fixture's text", read.status === 200 && body.read?.text === "fixture screen", read.status + " " + (body.read?.text ?? ""));
  check("the defaults are visible/text", body.read?.source === "visible" && body.read?.format === "text", `${body.read?.source}/${body.read?.format}`);
  check("the pane id is forwarded", body.read?.pane_id === "w:p1", body.read?.pane_id ?? "");

  const ansi = await fetch(`${base}/api/pane/read?pane_id=w:p1&format=ansi`).then((r) => r.json()) as { read?: { format?: string } };
  check("format=ansi is forwarded", ansi.read?.format === "ansi", ansi.read?.format ?? "");

  const detection = await fetch(`${base}/api/pane/read?pane_id=w:p1&source=detection`).then((r) => r.json()) as { read?: { source?: string } };
  check("source=detection is forwarded", detection.read?.source === "detection", detection.read?.source ?? "");

  const badSource = await fetch(`${base}/api/pane/read?pane_id=w:p1&source=bogus`);
  check("an unknown source is refused here, not sent on", badSource.status === 400, String(badSource.status));
  await badSource.text();

  const missing = await fetch(`${base}/api/pane/read`);
  check("a missing pane_id is 400", missing.status === 400, String(missing.status));
  await missing.text();

  const wrongMethod = await fetch(`${base}/api/pane/read?pane_id=w:p1`, { method: "POST" });
  check("a POST to read is 400", wrongMethod.status === 400, String(wrongMethod.status));
  await wrongMethod.text();

  const scroll = await fetch(`${base}/api/pane/scroll?pane_id=w:p1`);
  const scrollBody = await scroll.json() as { scroll?: { max_offset_from_bottom?: number } };
  check("scroll_info answers with the fixture's offset", scroll.status === 200 && scrollBody.scroll?.max_offset_from_bottom === 40, String(scrollBody.scroll?.max_offset_from_bottom));

  const post = await fetch(`${base}/api/pane/scroll`, { method: "POST", body: JSON.stringify({ pane_id: "w:p1", offset_from_bottom: 7 }) });
  const postBody = await post.json() as { scroll?: { offset_from_bottom?: number } };
  check("the posted offset reaches herdr", postBody.scroll?.offset_from_bottom === 7, String(postBody.scroll?.offset_from_bottom));

  upstream.stop(true);
  await Bun.sleep(150);
  const health = await fetch(`${base}/api/health`);
  check("the proxied route fails once v1 is gone", health.status === 502, String(health.status));
  await health.text();
  const native = await fetch(`${base}/api/pane/read?pane_id=w:p1`);
  check("the native read still answers with v1 stopped", native.status === 200, String(native.status));
  await native.text();
} catch (error) {
  check("the pane gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child?.kill("SIGKILL");
  try { daemon.stop(); } catch { /* already closed */ }
  try { upstream.stop(true); } catch { /* already stopped */ }
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-pane: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-pane: all checks passed");
