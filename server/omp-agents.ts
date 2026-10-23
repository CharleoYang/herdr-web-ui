import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { OmpAgent, OmpAgents } from "../shared/omp-agents.ts";
import { readLines, remember } from "./claude-subagents.ts";
import { record, resultText } from "./transcript-records.ts";

const BUDGET = 1024 * 1024;
const MAX_AGENTS = 64;
const MAX_CACHE = 128;
const MAX_TEXT = 24_000;
interface Scan {
  ino: number; size: number; mtime: number; offset: number; skipping: boolean;
  parent: string | null; initialized: boolean; value: OmpAgent;
}
const scans = new Map<string, Scan>();
const word = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const text = (value: unknown): string => typeof value === "string" ? value.slice(0, MAX_TEXT) : "";

function consume(scan: Scan, line: string): void {
  let row;
  try { row = record(JSON.parse(line)); } catch { return; } // append may be incomplete
  const agent = scan.value;
  if (row.type === "session") scan.parent = word(row.parentSession);
  if (row.type === "session_init") {
    scan.initialized = true;
    agent.agent = word(row.agent);
    agent.model = word(row.resolvedModel);
    agent.assignment = text(row.task);
  }
  if (row.type === "model_change") agent.model = word(row.model) ?? agent.model;
  if (row.type === "custom" && row.customType === "session_exit") {
    // Disposal after yield is normal; without a submitted result it proves only interruption.
    if (agent.status === "unknown") agent.status = "interrupted";
    return;
  }
  if (row.type !== "message") return;
  const message = record(row.message);
  if (typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp))) agent.updatedAt = row.timestamp;
  if (message.role === "user") { agent.status = "unknown"; agent.result = ""; agent.activity = ""; }
  if (message.role === "assistant") {
    agent.status = "unknown"; agent.result = "";
    if (word(message.provider) && word(message.model)) agent.model = `${message.provider}/${message.model}`;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const part = record(block);
      if (part.type !== "toolCall" || part.name === "yield") continue;
      const args = record(part.arguments);
      agent.activity = (word(args.i) ?? word(args.description) ?? word(part.name) ?? "").slice(0, 300);
    }
    if (message.stopReason === "error") { agent.status = "failed"; agent.result = text(message.errorMessage); }
    if (message.stopReason === "aborted") agent.status = "cancelled";
  }
  if (message.role === "toolResult" && message.toolName === "yield") {
    if (message.isError === true) return; // rejected yield did not submit anything
    const details = record(message.details);
    agent.status = "submitted";
    const value = details.data ?? details.result;
    agent.result = value === undefined ? text(resultText(message.content))
      : typeof value === "string" ? text(value) : text(JSON.stringify(value, null, 2));
  }
}

/** Direct children only. A sibling file is not trusted until its session header names this parent.
 * Reads append-only checkpoints, at most 1 MiB/file/call; unchanged files cost only stat.
 * No process liveness is inferred from a missing yield or from a recently modified file.
 */
export async function readOmpAgents(transcript: string): Promise<OmpAgents> {
  const parent = await realpath(transcript);
  if (!parent.endsWith(".jsonl")) return { agents: [] };
  const directory = parent.slice(0, -6);
  try {
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) return { agents: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { agents: [] };
    throw error;
  }
  const files = await readdir(directory, { withFileTypes: true });
  const candidates = await Promise.all(files.filter((entry) => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9_-]*\.jsonl$/.test(entry.name)).map(async (entry) => {
    const path = join(directory, entry.name);
    try { return { path, info: await stat(path) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }));
  const recent = candidates.filter((item) => item !== null).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, MAX_AGENTS);
  const agents: OmpAgent[] = [];
  for (const { path, info } of recent) {
    // Do not follow topic/journal links outside the selected session's artifact directory.
    if (await realpath(path) !== path) continue;
    let scan = scans.get(path);
    if (!scan || scan.ino !== info.ino || scan.offset > info.size || (scan.size === info.size && scan.mtime !== info.mtimeMs)) {
      scan = { ino: info.ino, size: info.size, mtime: info.mtimeMs, offset: 0, skipping: false, parent: null, initialized: false,
        value: { id: basename(path, ".jsonl"), agent: null, model: null, assignment: "", status: "unknown", activity: "", updatedAt: null, result: "" } };
    }
    let progress = scan.offset < info.size
      ? readLines(path, scan.offset, info.size, BUDGET, (line) => consume(scan!, line), scan.skipping)
      : { offset: scan.offset, skipping: false, more: false, failed: false };
    // A large session_init/tool result must not pin this cursor forever at the smaller share.
    if (progress.more && progress.offset === scan.offset) progress = readLines(path, scan.offset, info.size, 8 * BUDGET, (line) => consume(scan!, line), scan.skipping);
    if (progress.failed) throw new Error(`Could not read OMP subagent ${basename(path)}`);
    scan.offset = progress.offset; scan.skipping = progress.skipping; scan.size = info.size; scan.mtime = info.mtimeMs;
    remember(scans, path, scan, MAX_CACHE);
    if (!scan.initialized || scan.parent === null || resolve(scan.parent) !== parent) continue;
    const tombstone = await stat(`${path}.tombstone`).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    agents.push({ ...scan.value, ...(scan.offset < info.size ? { status: "unknown" as const, result: "" } : {}), ...(tombstone ? { status: "cancelled" as const } : {}) });
  }
  return { agents };
}
