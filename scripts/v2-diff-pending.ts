/**
 * Spec T-07's core gate: pending input and composer drafts survive a crash, an item caught
 * mid-send recovers as `uncertain` rather than `done`, and the state can be exported and imported.
 *
 *   bun scripts/v2-diff-pending.ts
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-pending-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const work = mkdtempSync(join(tmpdir(), "ovis-v2-pending-state-"));
const statePath = join(work, "state.json");

interface Gateway { port: number; stop: () => void }
async function start(state: string): Promise<Gateway> {
  const child = Bun.spawn([BINARY, "--dist", dist, "--test-listen", "--port", "0", "--state", state], {
    stdout: "pipe", stderr: "pipe",
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
  return { port, stop: () => child.kill("SIGKILL") };
}
async function api(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: response.status, json };
}

let gateway = await start(statePath);
try {
  check("the gateway starts", gateway.port > 0);

  const submitted = await api(gateway.port, "POST", "/test/pending/submit", { pane_id: "w1:p1", text: "hello" });
  const id = submitted.json?.id as string;
  check("submit returns an id", typeof id === "string" && id.length > 0, JSON.stringify(submitted.json));

  let list = await api(gateway.port, "GET", "/test/pending?pane_id=w1:p1");
  check("the item is queued", list.json?.pending?.[0]?.state === "queued", JSON.stringify(list.json));

  await api(gateway.port, "POST", "/test/pending/resolve", { id, outcome: "sending" });
  list = await api(gateway.port, "GET", "/test/pending?pane_id=w1:p1");
  check("the item is sending", list.json?.pending?.[0]?.state === "sending");

  // crash while the write is in flight: recovery must not call it done
  gateway.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  gateway = await start(statePath);
  list = await api(gateway.port, "GET", "/test/pending?pane_id=w1:p1");
  check("a crash mid-send recovers as uncertain", list.json?.pending?.[0]?.state === "uncertain", JSON.stringify(list.json?.pending?.[0]));
  check("the item's text survives the crash", list.json?.pending?.[0]?.text === "hello");

  await api(gateway.port, "POST", "/test/pending/resolve", { id, outcome: "done" });
  await api(gateway.port, "POST", "/test/composer", { pane_id: "w1:p1", draft: "draft text" });
  gateway.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  gateway = await start(statePath);
  list = await api(gateway.port, "GET", "/test/pending?pane_id=w1:p1");
  check("a completed item stays done across a restart", list.json?.pending?.[0]?.state === "done");
  const draft = await api(gateway.port, "GET", "/test/composer?pane_id=w1:p1");
  check("the composer draft survives a restart", draft.json?.draft === "draft text", JSON.stringify(draft.json));

  const exported = await api(gateway.port, "GET", "/test/state/export");
  const exportedText = JSON.stringify(exported.json);
  check("export carries the pending item and the draft", exportedText.includes("hello") && exportedText.includes("draft text"));

  // import into a fresh state file: a different gateway must see the same truth
  const importedPath = join(work, "imported.json");
  writeFileSync(importedPath, JSON.stringify(exported.json));
  const imported = await start(importedPath);
  try {
    const importedList = await api(imported.port, "GET", "/test/pending?pane_id=w1:p1");
    check("an imported state lists the same item", importedList.json?.pending?.[0]?.text === "hello" && importedList.json?.pending?.[0]?.state === "done");
    const importedDraft = await api(imported.port, "GET", "/test/composer?pane_id=w1:p1");
    check("an imported state restores the draft", importedDraft.json?.draft === "draft text");
  } finally {
    imported.stop();
  }

  const raw = JSON.parse(readFileSync(statePath, "utf8"));
  check("the state file is valid JSON on disk", Array.isArray(raw.pending) && typeof raw.drafts === "object");
} catch (error) {
  check("the pending gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  gateway.stop();
  rmSync(dist, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-pending: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-pending: all checks passed");
