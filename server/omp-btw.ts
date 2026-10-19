import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { BtwHistory, BtwTopic, BtwTurn } from "../shared/omp-btw.ts";

const statuses = new Set<BtwTurn["status"]>(["running", "complete", "cancelled", "error", "interrupted"]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const timestamp = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const isTurn = (value: unknown): value is BtwTurn => {
  const row = record(value);
  return typeof row.question === "string" && typeof row.answer === "string" && statuses.has(row.status as BtwTurn["status"])
    && timestamp(row.createdAt) && timestamp(row.updatedAt) && (row.error === undefined || typeof row.error === "string");
};

/** Match OMP's artifactsDirectoryFor and unscoped main-session BtwHistoryStore.
 * Do not recurse into sessions/: those topics belong to focused subagents, not this transcript.
 * A missing store is normal on older OMP; unreadable or invalid saved data is an error, not an empty history.
 */
export async function readBtwHistory(transcript: string): Promise<BtwHistory> {
  const path = await realpath(transcript);
  if (!path.endsWith(".jsonl")) return { topics: [] };
  const directory = join(path.slice(0, -6), "btw-history");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { topics: [] };
    throw error;
  }
  const topics: BtwTopic[] = [];
  for (const entry of entries) {
    const match = /^entry-([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.json$/.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    // OMP atomically replaces a topic: only read committed .json files, never locks or .tmp files.
    const value: unknown = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
    const row = record(value);
    if (!isTurn(value) || row.id !== match[1] || !(row.leafId === null || typeof row.leafId === "string")
      || (row.followUps !== undefined && (!Array.isArray(row.followUps) || !row.followUps.every(isTurn)))) {
      throw new Error("Invalid saved OMP BTW topic");
    }
    topics.push(value as BtwTopic);
  }
  topics.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  // Preserve the saved status: a read-only observer cannot infer whether a running writer was interrupted.
  return { topics };
}
