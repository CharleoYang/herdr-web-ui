/**
 * T-04's gate: `/api/session` is answered by the gateway's own RPC read, and must keep answering
 * after v1 is stopped — while a proxied route fails. That split is what a proxy-only fake cannot pass.
 *
 *   bun scripts/v2-diff-session.ts
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

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-session-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const socketPath = join(dist, "herdr.sock");

const fixture = {
  protocol: 22,
  version: "fixture-herdr",
  focused_pane_id: "w1:p2",
  workspaces: [{ workspace_id: "w1", label: "fixture" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
  panes: [
    { pane_id: "w1:p1", agent: "omp", agent_status: "idle", cwd: "/fixture" },
    { pane_id: "w1:p2", agent: "claude", agent_status: "working", cwd: "/fixture" },
  ],
  layouts: [],
  agents: [],
};

const daemon = Bun.listen({
  unix: socketPath,
  socket: {
    data(socket, chunk) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as { id?: string; method?: string };
        if (frame.method === "session.snapshot") {
          socket.write(`${JSON.stringify({ id: frame.id, result: fixture })}\n`);
        } else {
          socket.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
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
  check("the gateway starts with a herdr socket", port > 0, text.slice(0, 120));
  const base = `http://127.0.0.1:${port}`;

  const session = await fetch(`${base}/api/session`);
  check("session is 200", session.status === 200, String(session.status));
  const body = await session.json() as { snapshot?: { protocol?: number; panes?: unknown[]; workspaces?: { workspace_id: string }[]; focused_pane_id?: string }; finish_epoch?: string; served_by?: string };
  check("the snapshot carries the fixture's protocol", body.snapshot?.protocol === 22, String(body.snapshot?.protocol));
  check("both fixture panes are present", body.snapshot?.panes?.length === 2, String(body.snapshot?.panes?.length));
  check("the workspace relationship survives", body.snapshot?.workspaces?.[0]?.workspace_id === "w1", JSON.stringify(body.snapshot?.workspaces));
  check("this bridge's own boot marker is present", typeof body.finish_epoch === "string" && body.finish_epoch.length > 0, body.finish_epoch ?? "");
  check("the answer says it is native", body.served_by === "v2", body.served_by ?? "");

  const health = await fetch(`${base}/api/health`);
  check("the proxied route works while v1 is up", health.status === 200, String(health.status));
  await health.text();

  // v1 goes away: the proxied route must fail, the native one must not notice
  upstream.stop(true);
  await Bun.sleep(150);
  const down = await fetch(`${base}/api/health`);
  check("the proxied route fails once v1 is gone", down.status === 502, String(down.status));
  await down.text();
  const still = await fetch(`${base}/api/session`);
  check("the native session still answers with v1 stopped", still.status === 200, String(still.status));
  const again = await still.json() as { snapshot?: { panes?: unknown[] } };
  check("and it is the same snapshot", again.snapshot?.panes?.length === 2);
} catch (error) {
  check("the session gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child?.kill("SIGKILL");
  try { daemon.stop(); } catch { /* already closed */ }
  try { upstream.stop(true); } catch { /* already stopped */ }
  rmSync(dist, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-session: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-session: all checks passed");
