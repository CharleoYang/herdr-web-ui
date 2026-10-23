import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOmpAgents } from "./omp-agents.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const lines = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  roots.push(root);
  const parent = join(root, "parent.jsonl");
  await writeFile(parent, ""); await mkdir(join(root, "parent"));
  const path = join(root, "parent", "Explorer.jsonl");
  const header = [{ type: "session", parentSession: parent }, { type: "session_init", agent: "scout", resolvedModel: "tokens/model", task: "Inspect the source" }];
  return { root, parent, path, header };
}
const yielded = (data: unknown, isError = false) => ({ type: "message", timestamp: "2026-10-19T01:00:00Z", message: { role: "toolResult", toolName: "yield", isError, details: { data }, content: [{ type: "text", text: "Result submitted." }] } });

test("direct child projects its model, prompt, activity and structured submitted result", async () => {
  const { parent, path, header } = await setup();
  await writeFile(path, lines(...header, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { i: "Checking source" } }] } }));
  expect((await readOmpAgents(parent)).agents).toEqual([{ id: "Explorer", agent: "scout", model: "tokens/model", assignment: "Inspect the source", status: "unknown", activity: "Checking source", updatedAt: null, result: "" }]);
  await appendFile(path, lines(yielded({ conclusion: "Verified", findings: ["one"] }), { type: "custom", customType: "session_exit" }));
  const child = (await readOmpAgents(parent)).agents[0]!;
  expect(child.status).toBe("submitted");
  expect(JSON.parse(child.result)).toEqual({ conclusion: "Verified", findings: ["one"] });
  expect(child.updatedAt).toBe("2026-10-19T01:00:00Z");
});

test("rejected yield is not completion, a resumed child drops its old result, tombstone cancels", async () => {
  const { parent, path, header } = await setup();
  await writeFile(path, lines(...header, yielded("bad", true)));
  expect((await readOmpAgents(parent)).agents[0]?.status).toBe("unknown");
  await appendFile(path, lines(yielded("Finished")));
  expect((await readOmpAgents(parent)).agents[0]?.result).toBe("Finished");
  await appendFile(path, lines({ type: "message", message: { role: "user", content: "Continue" } }));
  expect((await readOmpAgents(parent)).agents[0]).toMatchObject({ status: "unknown", result: "", activity: "" });
  await writeFile(`${path}.tombstone`, "");
  expect((await readOmpAgents(parent)).agents[0]?.status).toBe("cancelled");
});

test("saved exit and provider errors do not pretend to be submitted results", async () => {
  const { parent, path, header } = await setup();
  await writeFile(path, lines(...header, { type: "custom", customType: "session_exit" }));
  expect((await readOmpAgents(parent)).agents[0]?.status).toBe("interrupted");
  await appendFile(path, lines({ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "Provider refused", content: [] } }));
  expect((await readOmpAgents(parent)).agents[0]).toMatchObject({ status: "failed", result: "Provider refused" });
});

test("same-folder journals and foreign-parent children are excluded; symlink artifacts are not read", async () => {
  const { root, parent, path, header } = await setup();
  await writeFile(path, lines(...header));
  await writeFile(join(root, "parent", "btw-history.jsonl"), lines({ type: "session_init", task: "Not a child" }));
  await writeFile(join(root, "parent", "Foreign.jsonl"), lines({ type: "session", parentSession: join(root, "other.jsonl") }, header[1], yielded("secret")));
  await symlink(path, join(root, "parent", "Alias.jsonl"));
  expect((await readOmpAgents(parent)).agents.map((agent) => agent.id)).toEqual(["Explorer"]);
  const other = join(root, "other.jsonl"); await writeFile(other, "");
  await symlink(join(root, "parent"), join(root, "other"));
  expect(await readOmpAgents(other)).toEqual({ agents: [] });
});

test("a partial append is not parsed until its newline; truncation replaces the old checkpoint", async () => {
  const { parent, path, header } = await setup();
  await writeFile(path, lines(...header));
  const result = JSON.stringify(yielded("Complete"));
  await appendFile(path, result.slice(0, -2));
  expect((await readOmpAgents(parent)).agents[0]?.status).toBe("unknown");
  await appendFile(path, result.slice(-2) + "\n");
  expect((await readOmpAgents(parent)).agents[0]?.status).toBe("submitted");
  await writeFile(path, lines(...header));
  expect((await readOmpAgents(parent)).agents[0]).toMatchObject({ status: "unknown", result: "" });
});

test("a session_init larger than the normal poll share does not stall the scan", async () => {
  const { parent, path, header } = await setup();
  await writeFile(path, lines(header[0], { ...header[1], systemPrompt: "x".repeat(2 * 1024 * 1024) }, yielded("Large header survived")));
  let agents = (await readOmpAgents(parent)).agents;
  for (let i = 0; i < 3 && agents[0]?.status !== "submitted"; i++) agents = (await readOmpAgents(parent)).agents;
  expect(agents[0]).toMatchObject({ status: "submitted", result: "Large header survived" });
});
