/**
 * Models the chat can offer an omp pane. The list comes from `omp models --json`.
 * A pick is sent as a typed `/switch provider/id`, which omp's TUI applies to this
 * session. `/model` in the TUI ignores arguments and opens its own hub.
 */

import type { OmpModelChoice } from "../shared/protocol.ts";

const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\/[A-Za-z0-9][A-Za-z0-9._:@-]{0,160}$/;

export function ompSwitchCommand(selector: string): string | null {
  if (!SELECTOR.test(selector)) return null;
  return `/switch ${selector}`;
}

export function parseOmpModels(text: string): OmpModelChoice[] {
  const parsed = JSON.parse(text) as { models?: unknown };
  if (!Array.isArray(parsed.models)) return [];
  const choices: OmpModelChoice[] = [];
  for (const item of parsed.models) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as { provider?: unknown; id?: unknown; selector?: unknown; name?: unknown; kind?: unknown };
    if (row.kind !== undefined && row.kind !== "chat") continue;
    if (typeof row.provider !== "string" || typeof row.id !== "string" || typeof row.selector !== "string") continue;
    if (row.selector !== `${row.provider}/${row.id}` || ompSwitchCommand(row.selector) === null) continue;
    choices.push({
      provider: row.provider,
      id: row.id,
      selector: row.selector,
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
    });
  }
  choices.sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
  return choices;
}

let cached: { at: number; models: OmpModelChoice[] } | null = null;
const CACHE_MS = 60_000;

export async function listOmpModels(): Promise<OmpModelChoice[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const proc = Bun.spawn(["omp", "models", "--json"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(stderr.trim() || `omp models exited ${code}`);
  const models = parseOmpModels(stdout);
  cached = { at: Date.now(), models };
  return models;
}
