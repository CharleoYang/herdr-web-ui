/**
 * T-01's gate. This must fail before the Rust gateway exists (red on HEAD), and must fail again if
 * the binary stops serving correctly or binds somewhere it must not.
 *
 *   bun scripts/v2-selftest.ts
 *
 * It owns its fixture: a temporary dist/, an ephemeral port, and the Rust binary it spawns. Nothing
 * here touches a running Ovis server, the user's herdr, or a well-known port.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const failures: string[] = [];
const checks: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-selftest-"));
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>ovis v2</body></html>\n");
writeFileSync(join(dist, "assets/app.js"), "export const answer = 42;\n");
// a precompressed sibling: the gateway must serve it when the client accepts gzip
writeFileSync(join(dist, "assets/app.js.gz"), gzipSync("export const answer = 42;\n"));

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });
}

let child: ReturnType<typeof Bun.spawn> | null = null;
try {
  let started = false;
  try {
    child = Bun.spawn([BINARY, "--dist", dist, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
    started = true;
  } catch (error) {
    check("Rust binary exists and starts (crates/ovis-v2/target/release/ovis-v2)", false, error instanceof Error ? error.message : String(error));
  }

  let port = 0;
  if (child !== null) {
    // read only until the startup line: waiting for EOF would hang on a running server
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5_000;
    while (text.length < 4000 && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
      if (next === null) continue;
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
      if (text.includes("\n")) break;
    }
    void reader.cancel().catch(() => {});
    const match = text.match(/listening on (?:http:\/\/)?127\.0\.0\.1:(\d+)/);
    check("prints the port it bound", match !== null, text.slice(0, 200));
    port = match === null ? 0 : Number(match[1]);
  }

  if (port !== 0) {
    const index = await request(port, "/");
    check("GET / is 200", index.status === 200, String(index.status));
    const etag = index.headers.get("etag");
    check("the index carries an ETag", etag !== null && etag.length > 0, etag ?? "");
    const html = await index.text();
    check("the body is the fixture's index", html.includes("ovis v2"), html.slice(0, 60));

    if (etag !== null) {
      const cached = await request(port, "/", { "if-none-match": etag });
      check("If-None-Match returns 304", cached.status === 304, String(cached.status));
    }

    const ranged = await request(port, "/assets/app.js", { range: "bytes=0-3" });
    check("Range gives 206", ranged.status === 206, String(ranged.status));
    const chunk = await ranged.text();
    check("the range body is the first four bytes", chunk === "expo", chunk);

    const plain = await request(port, "/assets/app.js", { "accept-encoding": "identity" });
    const plainEncoding = plain.headers.get("content-encoding");
    check("no content-encoding without Accept-Encoding", plainEncoding === null, plainEncoding ?? "");
    await plain.arrayBuffer();

    const gz = await request(port, "/assets/app.js", { "accept-encoding": "gzip" });
    const encoding = gz.headers.get("content-encoding");
    check("the precompressed sibling is used when the client accepts gzip", encoding === "gzip", encoding ?? "");
    // Bun decodes gzip for us: the contract is the header says gzip and the decoded body is the asset
    const decoded = await gz.text();
    check("the gzip response decodes to the asset", decoded === "export const answer = 42;\n", `${decoded.length} chars`);

    const missing = await request(port, "/nope.txt");
    check("an unknown path is 404", missing.status === 404, String(missing.status));
    await missing.text();
  }

  if (child !== null) {
    const start = Date.now();
    child.kill("SIGTERM");
    await child.exited;
    check("SIGTERM stops the server within 2 s", Date.now() - start < 2_000, `${Date.now() - start} ms`);
  }

  // a non-loopback bind must be refused: this must never open a public listener
  try {
    const refused = Bun.spawnSync([BINARY, "--dist", dist, "--port", "0", "--host", "0.0.0.0"], { stdout: "pipe", stderr: "pipe" });
    check("a public bind is refused", refused.exitCode !== 0, `exit ${refused.exitCode}: ${refused.stderr.toString().slice(0, 120)}`);
  } catch (error) {
    check("a public bind is refused", false, error instanceof Error ? error.message : String(error));
  }
} finally {
  child?.kill("SIGKILL");
  rmSync(dist, { recursive: true, force: true });
}

for (const line of checks) console.log(line);
if (failures.length > 0) {
  console.error(`v2-selftest: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-selftest: all checks passed");
