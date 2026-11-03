/**
 * Spec T-09's core gate: cursor reads never lose or repeat a record, appends continue, truncation
 * resets, oversized and malformed records are reported instead of silently dropped, and a matching
 * ETag with nothing new is a real 304.
 *
 *   bun scripts/v2-diff-conversation.ts
 */
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const dist = mkdtempSync(join(tmpdir(), "ovis-v2-conv-dist-"));
writeFileSync(join(dist, "index.html"), "<html>fixture</html>");
const transcripts = mkdtempSync(join(tmpdir(), "ovis-v2-conv-"));
const file = join(transcripts, "s1.jsonl");
function record(index: number): string {
  return JSON.stringify({ type: "message", role: index % 2 ? "agent" : "user", text: `m${index}` });
}
writeFileSync(file, Array.from({ length: 25 }, (_, index) => record(index)).join("\n") + "\n");

const child = Bun.spawn([BINARY, "--dist", dist, "--test-listen", "--port", "0", "--transcripts", transcripts], {
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
check("the gateway starts", port > 0, banner.slice(0, 80));

async function page(query: string, etag?: string): Promise<{ status: number; json: any; etag: string | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/test/conversation?${query}`, {
    headers: etag ? { "if-none-match": etag } : {},
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 304 has no body */ }
  return { status: response.status, json, etag: response.headers.get("etag") };
}

try {
  const first = await page("session=s1&cursor=0&limit=10");
  check("the first page has ten records", first.json?.events?.length === 10, `${first.json?.events?.length}`);
  check("the order is the file's order", first.json?.events?.[0]?.text === "m0" && first.json?.events?.[9]?.text === "m9");
  check("the cursor advances by what was read", first.json?.next_cursor === 10, `${first.json?.next_cursor}`);
  check("the total is reported", first.json?.total === 25);

  const second = await page("session=s1&cursor=10&limit=10");
  check("the second page continues without repeats", second.json?.events?.[0]?.text === "m10" && second.json?.events?.[9]?.text === "m19");

  const third = await page("session=s1&cursor=20&limit=10");
  check("the last page is complete", third.json?.events?.length === 5 && third.json?.events?.[4]?.text === "m24" && third.json?.next_cursor === 25);
  check("the last page is not truncated", third.json?.truncated === false);

  const exhausted = await page("session=s1&cursor=25");
  check("an exhausted cursor returns no records", exhausted.json?.events?.length === 0 && exhausted.json?.next_cursor === 25);

  const etagBefore = first.etag;
  appendFileSync(file, record(25) + "\n" + record(26) + "\n");
  const appended = await page("session=s1&cursor=25");
  check("an append is read exactly once", appended.json?.events?.length === 2 && appended.json?.events?.[0]?.text === "m25" && appended.json?.events?.[1]?.text === "m26");
  check("the cursor follows the append", appended.json?.next_cursor === 27);
  check("the ETag changes when the file changes", appended.etag !== null && appended.etag !== etagBefore, `${etagBefore} -> ${appended.etag}`);

  const notModified = await page("session=s1&cursor=27", appended.etag ?? "");
  check("nothing new plus a matching ETag is 304", notModified.status === 304, `${notModified.status}`);

  // truncate back to five records: the old cursor is beyond the file and must reset
  writeFileSync(file, Array.from({ length: 5 }, (_, index) => record(index)).join("\n") + "\n");
  const reset = await page("session=s1&cursor=27");
  check("a truncated file resets the cursor", reset.json?.reset === true, JSON.stringify({ reset: reset.json?.reset, next: reset.json?.next_cursor }));
  check("the reset re-reads from the start", reset.json?.events?.[0]?.text === "m0" && reset.json?.events?.length === 5);

  appendFileSync(file, JSON.stringify({ type: "big", text: "x".repeat(1024 * 1024 + 100) }) + "\n");
  const oversized = await page("session=s1&cursor=5");
  const big = oversized.json?.events?.find((event: any) => event.type === "oversized");
  check("an oversized record is reported by size", big !== undefined && big.bytes > 1024 * 1024, JSON.stringify(big ?? {}));
  check("the oversized record is not returned whole", !JSON.stringify(oversized.json).includes("x".repeat(1000)));

  appendFileSync(file, '{"type":"broken", "text": "unterminated' + "\n");
  const malformed = await page("session=s1&cursor=6");
  check("a malformed record is reported, not dropped", malformed.json?.events?.some((event: any) => event.type === "malformed") === true, JSON.stringify(malformed.json?.events));

  const budgeted = await page("session=s1&cursor=0&limit=100&budget=200");
  check("a small budget truncates the page", budgeted.json?.truncated === true && budgeted.json.events.length < 5, `${budgeted.json?.events?.length} events`);

  const traversal = await page("session=../etc");
  check("a session id cannot traverse the directory", traversal.status === 400, `${traversal.status}`);
} catch (error) {
  check("the conversation gate runs", false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill("SIGKILL");
  rmSync(dist, { recursive: true, force: true });
  rmSync(transcripts, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`v2-diff-conversation: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("v2-diff-conversation: all checks passed");
