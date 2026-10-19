import { afterEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBtwHistory } from "./omp-btw.ts";
import type { BtwTopic, BtwTurn } from "../shared/omp-btw.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herdr-btw-"));
  roots.push(root);
  const transcript = join(root, "main.jsonl");
  await writeFile(transcript, '{"type":"session","id":"main"}\n');
  const directory = join(root, "main", "btw-history");
  await mkdir(directory, { recursive: true });
  return { root, transcript, directory };
}
const turn: BtwTurn = { question: "Explain **this**", answer: "A `side` answer", status: "complete", createdAt: 100, updatedAt: 200 };

it("keeps every follow-up and its recorded status in topic creation order, not checkpoint order", async () => {
  const { transcript, directory } = await fixture();
  const topic: BtwTopic = { ...turn, id: "one", leafId: "leaf", followUps: [
    { ...turn, question: "And then?", answer: "", status: "running", createdAt: 300, updatedAt: 301 },
    { ...turn, status: "error", error: "Provider unavailable", createdAt: 400, updatedAt: 500 },
  ] };
  const newer: BtwTopic = { ...turn, id: "two", leafId: null, createdAt: 201, status: "cancelled" };
  await writeFile(join(directory, "entry-one.json"), JSON.stringify(topic));
  await writeFile(join(directory, "entry-two.json"), JSON.stringify(newer));
  expect(await readBtwHistory(transcript)).toEqual({ topics: [newer, topic] });
});

it("never borrows another session or a focused subagent's history, or a writer's temporary checkpoint", async () => {
  const { root, transcript, directory } = await fixture();
  const topic = { ...turn, id: "other", leafId: null };
  await mkdir(join(directory, "sessions", "child"), { recursive: true });
  await writeFile(join(directory, "sessions", "child", "entry-other.json"), JSON.stringify(topic));
  await writeFile(join(directory, "entry-other.json.123.tmp"), JSON.stringify(topic));
  await mkdir(join(root, "other", "btw-history"), { recursive: true });
  const other = join(root, "other", "btw-history", "entry-other.json");
  await writeFile(other, JSON.stringify(topic));
  await symlink(other, join(directory, "entry-other.json"));
  expect(await readBtwHistory(transcript)).toEqual({ topics: [] });
});

it("distinguishes a missing store from corrupt saved history, including mismatched ids and invalid follow-ups", async () => {
  const { transcript, directory } = await fixture();
  await rm(directory, { recursive: true });
  expect(await readBtwHistory(transcript)).toEqual({ topics: [] });
  await mkdir(directory);
  for (const topic of [
    { ...turn, id: "not-one", leafId: null },
    { ...turn, id: "one", leafId: null, followUps: [{ ...turn, status: "made-up" }] },
    { ...turn, id: "one", leafId: null, createdAt: 8640000000000001 },
  ]) {
    await writeFile(join(directory, "entry-one.json"), JSON.stringify(topic));
    await expect(readBtwHistory(transcript)).rejects.toThrow("Invalid saved OMP BTW topic");
  }
});

it("observes topic checkpoints without any main-transcript change", async () => {
  const { transcript, directory } = await fixture();
  const path = join(directory, "entry-live.json");
  const initial: BtwTopic = { ...turn, id: "live", leafId: null, answer: "", status: "running" };
  await writeFile(path, JSON.stringify(initial));
  expect((await readBtwHistory(transcript)).topics[0]?.status).toBe("running");
  await writeFile(path, JSON.stringify({ ...initial, answer: "Saved final answer", status: "complete", updatedAt: 300 }));
  expect((await readBtwHistory(transcript)).topics[0]).toMatchObject({ answer: "Saved final answer", status: "complete", updatedAt: 300 });
});
