import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What Claude Code pipes to its status line, kept by `~/.herdr/statusline-tee.sh` (the statusLine
 * command it wraps). Read here instead of asking Anthropic: this is the same payload Claude's own
 * line draws from, it needs no token, and it never leaves the machine — the usage endpoint answers
 * 403 from some networks, where this file still holds the numbers.
 *
 * The payload's shape, as Claude Code 2.1.308 writes it:
 *   rate_limits.five_hour  { used_percentage, resets_at }   resets_at in epoch SECONDS
 *   rate_limits.seven_day  { used_percentage, resets_at }
 *   context_window         { used_percentage, remaining_percentage, context_window_size, ... }
 *   model { id, display_name }  session_id  cost.total_cost_usd  version
 */
export interface StatuslinePayload {
  /** when the file was last written: the status line renders on activity, so an idle pane's is old */
  readAt: number;
  sessionId: string | null;
  model: string | null;
  /** percent used, or null when the payload names none */
  fiveHour: StatuslineWindow | null;
  sevenDay: StatuslineWindow | null;
  context: { usedPercent: number | null; window: number | null } | null;
}

export interface StatuslineWindow {
  usedPercent: number;
  /** ISO time, from the payload's epoch seconds; null when it names none */
  resetsAt: string | null;
}

/**
 * A payload older than this is not a reading: the five-hour window has turned over, so its number
 * describes a window that is gone. The file survives a sleeping laptop, so its age is checked.
 */
export const STALE_MS = 6 * 60 * 60_000;

export const statuslinePath = (home: string): string => join(home, ".herdr", "statusline-last.json");

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const percent = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null);

function window(value: unknown): StatuslineWindow | null {
  const found = record(value);
  const used = percent(found["used_percentage"]);
  if (used === null) return null;
  const resets = found["resets_at"];
  const resetsAt = typeof resets === "number" && Number.isFinite(resets) && resets > 0 ? new Date(resets * 1000).toISOString() : null;
  return { usedPercent: used, resetsAt };
}

export function parseStatusline(payload: unknown, readAt: number): StatuslinePayload | null {
  const body = record(payload);
  const limits = record(body["rate_limits"]);
  const fiveHour = window(limits["five_hour"]);
  const sevenDay = window(limits["seven_day"]);
  const contextWindow = record(body["context_window"]);
  const contextUsed = percent(contextWindow["used_percentage"]);
  const contextSize = typeof contextWindow["context_window_size"] === "number" ? contextWindow["context_window_size"] : null;
  // a payload with nothing this reader shows is not a reading (an older Claude Code, a stub)
  if (fiveHour === null && sevenDay === null && contextUsed === null) return null;
  return {
    readAt,
    sessionId: text(body["session_id"]),
    model: text(record(body["model"])["display_name"]) ?? text(record(body["model"])["id"]),
    fiveHour,
    sevenDay,
    context: contextUsed === null ? null : { usedPercent: contextUsed, window: contextSize },
  };
}

/** The newest payload under `home`, or null: absent, unreadable, or older than STALE_MS. */
export function readStatusline(home: string, now: number = Date.now()): StatuslinePayload | null {
  const path = statuslinePath(home);
  try {
    const stat = statSync(path);
    if (now - stat.mtimeMs > STALE_MS) return null;
    return parseStatusline(JSON.parse(readFileSync(path, "utf8")), stat.mtimeMs);
  } catch {
    return null;
  }
}
