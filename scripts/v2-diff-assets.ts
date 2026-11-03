/**
 * A precompressed asset must keep its logical Content-Type: a browser refuses a module script
 * served as application/octet-stream, which is exactly how the app went blank. Also checks the
 * encoding negotiation and that a range is taken from the identity bytes.
 *
 *   bun scripts/v2-diff-assets.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-assets-"));
const script = 'console.log("hello from the app");\n'.repeat(64);
writeFileSync(join(dist, "index.html"), "<html><body>app</body></html>");
writeFileSync(join(dist, "app.js"), script);
writeFileSync(join(dist, "app.js.gz"), gzipSync(script));
writeFileSync(join(dist, "app.js.br"), brotliCompressSync(script));
writeFileSync(join(dist, "hello.md"), "plain text\n");

const child = Bun.spawn([BINARY, "--dist", dist, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
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
check("the gateway starts", port > 0, banner.slice(0, 80));

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string | null; encoding: string | null; body: Buffer }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    encoding: response.headers.get("content-encoding"),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

try {
  const br = await get("/app.js", { "accept-encoding": "br, gzip" });
  check("br is preferred when offered", br.encoding === "br", `${br.encoding}`);
  check("a br asset keeps the javascript type", br.type?.startsWith("text/javascript") === true, `${br.type}`);
  // fetch decodes the transfer encoding itself: compare the decoded text to the source
  check("the br body decodes to the source", br.body.toString() === script);

  const gz = await get("/app.js", { "accept-encoding": "gzip" });
  check("gzip is used when br is not offered", gz.encoding === "gzip", `${gz.encoding}`);
  check("a gzip asset keeps the javascript type", gz.type?.startsWith("text/javascript") === true, `${gz.type}`);
  check("the gzip body decodes to the source", gz.body.toString() === script);

  const identity = await get("/app.js", { "accept-encoding": "identity" });
  check("no accept-encoding returns the identity bytes", identity.encoding === null && identity.body.toString() === script, `${identity.encoding}`);

  const ranged = await get("/app.js", { "accept-encoding": "br, gzip", range: "bytes=0-9" });
  check("a range is taken from identity, never from a compressed stream", ranged.encoding === null && ranged.status === 206 && ranged.body.toString() === script.slice(0, 10), `${ranged.status} ${ranged.encoding} ${JSON.stringify(ranged.body.toString())}`);

  const html = await get("/");
  check("index.html keeps its html type", html.type?.startsWith("text/html") === true, `${html.type}`);

  const md = await get("/hello.md", { "accept-encoding": "identity" });
  check("v1's MIME table is matched for .md", md.encoding === null && md.type?.startsWith("text/plain") === true && md.body.toString() === "plain text\n", `${md.type}`);
} catch (error) {
  check("the asset gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill("SIGKILL");
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-assets: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-assets: all checks passed");
