/**
 * Spec T-10's core gate: direct loopback is trusted, a proxied request needs the token, Origin and
 * device are enforced, a revoked device is refused before anything else, and forwarding headers
 * from an untrusted peer are rejected rather than believed.
 *
 *   bun scripts/v2-diff-access.ts
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

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-access-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");

interface Gateway { port: number; stop: () => void }
async function start(extra: string[]): Promise<Gateway> {
  const child = Bun.spawn([BINARY, "--dist", dist, "--port", "0", ...extra], { stdout: "pipe", stderr: "pipe" });
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
  return { port: Number(text.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? 0), stop: () => child.kill("SIGKILL") };
}
async function status(port: number, headers: Record<string, string>, query = ""): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/pending?pane_id=w1:p1${query}`, { headers });
  return { status: response.status, body: await response.text() };
}

const trusted = await start(["--token", "secret", "--allow-origin", "https://good", "--revoke", "dead-device", "--trust-proxy", "--native-state"]);
try {
  check("the trusted-proxy gateway starts", trusted.port > 0);
  const forwarded = { "x-forwarded-for": "1.2.3.4" };

  const direct = await status(trusted.port, {});
  check("a direct loopback request is admitted without a token", direct.status === 200, `${direct.status}`);

  const noToken = await status(trusted.port, forwarded);
  check("a proxied request without a token is 401", noToken.status === 401 && noToken.body.includes("token"), `${noToken.status} ${noToken.body}`);

  const wrong = await status(trusted.port, { ...forwarded, authorization: "Bearer wrong" });
  check("a wrong token is 401", wrong.status === 401);

  const bearer = await status(trusted.port, { ...forwarded, authorization: "Bearer secret" });
  check("the bearer token admits a proxied request", bearer.status === 200, `${bearer.status}`);

  const viaQuery = await status(trusted.port, forwarded, "&token=secret");
  check("the query token admits a proxied request", viaQuery.status === 200, `${viaQuery.status}`);

  const badOrigin = await status(trusted.port, { origin: "https://evil" });
  check("a disallowed Origin is 403", badOrigin.status === 403 && badOrigin.body.includes("origin"), `${badOrigin.status}`);

  const goodOrigin = await status(trusted.port, { origin: "https://good" });
  check("an allowed Origin is admitted", goodOrigin.status === 200);

  const revoked = await status(trusted.port, { ...forwarded, authorization: "Bearer secret", "x-device-id": "dead-device" });
  check("a revoked device is 403 even with a valid token", revoked.status === 403 && revoked.body.includes("device"), `${revoked.status} ${revoked.body}`);

  const live = await status(trusted.port, { ...forwarded, authorization: "Bearer secret", "x-device-id": "live-device" });
  check("a live device with a valid token is admitted", live.status === 200);
} finally {
  trusted.stop();
}

const untrusted = await start(["--token", "secret", "--native-state"]);
try {
  const spoofed = await status(untrusted.port, { "x-forwarded-for": "1.2.3.4", authorization: "Bearer secret" });
  check("forwarding headers from an untrusted peer are 403", spoofed.status === 403 && spoofed.body.includes("forwarded"), `${spoofed.status} ${spoofed.body}`);
  const direct = await status(untrusted.port, {});
  check("a direct request to the untrusted-proxy gateway is still admitted", direct.status === 200);
} finally {
  untrusted.stop();
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-access: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-access: all checks passed");
