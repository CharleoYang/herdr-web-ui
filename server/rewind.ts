import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import type { RewindPoint, RewindRestore } from "../shared/rewind.ts";

/**
 * Claude Code's rewind points, read from a session file.
 *
 * A checkpoint is a `file-history-snapshot` whose `messageId` is a user message's `uuid`: restoring
 * it puts back the files that message overwrote and cuts the conversation before it. The dialog lists
 * exactly those messages, oldest first, so this order is what an index into the list means.
 */
export function rewindPoints(jsonl: string): RewindPoint[] {
  const files = new Map<string, number>();
  const points: RewindPoint[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // a line being written as it is read: the rest of the file still counts
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    const entry = record as Record<string, unknown>;
    if (entry["type"] === "file-history-snapshot") {
      const snapshot = entry["snapshot"];
      const messageId = entry["messageId"] ?? (snapshot !== null && typeof snapshot === "object" ? (snapshot as Record<string, unknown>)["messageId"] : null);
      if (typeof messageId === "string") {
        const backups = snapshot !== null && typeof snapshot === "object" ? (snapshot as Record<string, unknown>)["trackedFileBackups"] : null;
        const count = backups !== null && typeof backups === "object" ? Object.keys(backups as Record<string, unknown>).length : 0;
        files.set(messageId, Math.max(files.get(messageId) ?? 0, count));
      }
      continue;
    }
    if (entry["type"] !== "user" || entry["isSidechain"] === true || entry["isMeta"] === true) continue;
    const uuid = entry["uuid"];
    const at = entry["timestamp"];
    if (typeof uuid !== "string" || typeof at !== "string") continue;
    const text = userMessageText(entry["message"]);
    if (text === null) continue;
    // a point named twice (a resumed turn keeps its uuid): the later record is the one the dialog shows
    const existing = points.findIndex((point) => point.message_id === uuid);
    const point: RewindPoint = { message_id: uuid, at, prompt: promptLine(text), files: files.get(uuid) ?? 0 };
    if (existing >= 0) points[existing] = point;
    else points.push(point);
  }
  // files are counted once every snapshot has been read: a snapshot can follow its message
  return points.map((point) => ({ ...point, files: files.get(point.message_id) ?? 0 }));
}

/** The message's own words, or null for a record that carries none (a tool result, a reminder). */
function userMessageText(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") {
    const text = stripHarnessBlocks(content).trim();
    return text === "" ? null : text;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    // a tool result is the harness talking, not the user
    if (item["type"] === "text" && typeof item["text"] === "string") parts.push(item["text"]);
  }
  const text = stripHarnessBlocks(parts.join("\n")).trim();
  return text === "" ? null : text;
}

/** The tags Claude Code wraps its own records in; text that opens with one is not a typed message. */
const HARNESS_TAGS = new Set([
  "task-notification",
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
]);

/**
 * What Claude Code wraps around a message is not the message: a slash command's own record, the
 * caveat it prints for one, an injected system reminder. The dialog lists typed messages only, so a
 * record left with nothing after these are removed is no checkpoint.
 */
function stripHarnessBlocks(text: string): string {
  const start = text.trimStart();
  // another session's delivery is a user-role record too, and nobody typed it here
  // (src/lib/teammateMessage.ts reads the same envelope for display)
  if (/^Another Claude session sent a message:/.test(start) || /<teammate-message\b/.test(text)) return "";
  // herdr's own inbox/msg envelopes reach a pane as a user turn too (the fork's dx/herdr bridge)
  if (/^\[herdr-(?:inbox|msg)\b/.test(start)) return "";
  // a record that is one harness tag is the harness speaking: a background task's result, a
  // command's own output, a reminder with nothing typed around it
  const harnessTag = /^<([a-z][a-z-]*)[\s>]/.exec(start)?.[1];
  if (harnessTag !== undefined && HARNESS_TAGS.has(harnessTag)) return "";
  // a compacted session's opening record says the earlier conversation is summarized, not typed
  if (/^This session is being continued from a previous conversation\b/.test(start)) return "";
  return text
    .replace(/<command-name>[\s\S]*?<\/command-args>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?(<\/local-command-caveat>|$)/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}

/** The line the dialog shows for a message: its first non-empty line, as long as a row can hold. */
function promptLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/** One row of the dialog's list: the message it restores, and whether it has code to put back. */
export interface RewindRow {
  text: string;
  code: boolean;
}

export type RewindPanel =
  /** The message list, `/rewind`'s first screen. */
  | { kind: "select"; rows: RewindRow[]; highlighted: number }
  /** The confirm screen of a chosen message, with its numbered options. */
  | { kind: "confirm"; target: string | null; options: string[]; highlighted: number }
  | null;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Claude Code's rewind panel as it is drawn under its own rule, in either of its two states: the
 * message list (`/rewind`), or the confirm screen of one message with numbered options. Null when
 * the screen does not end in that panel.
 */
export function rewindPanel(screen: string): RewindPanel {
  const lines = screen.replace(ANSI, "").split(/\r?\n/).map((line) => line.trimEnd());
  let rule = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("▔") || trimmed.endsWith("▔")) { rule = index; break; }
  }
  if (rule < 0) return null;
  const below = lines.slice(rule + 1).map((line) => line.trim());
  if (below.every((line) => line === "")) return null;
  const blocks: string[][] = [];
  for (const line of below) {
    if (line === "") { if (blocks.length > 0 && blocks.at(-1)!.length > 0) blocks.push([]); continue; }
    if (blocks.length === 0) blocks.push([]);
    blocks.at(-1)!.push(line);
  }
  const filled = blocks.filter((block) => block.length > 0);
  if (filled.length === 0 || filled[0]![0] !== "Rewind") return null;
  const body = filled.slice(1);

  const options: string[] = [];
  let optionHighlight = -1;
  for (const block of body) {
    for (const line of block) {
      const match = /^(❯\s*)?(\d+)\.\s*(.+)$/.exec(line);
      if (match === null) continue;
      if (match[1] !== undefined && optionHighlight < 0) optionHighlight = options.length;
      options.push(match[3]!.trim());
    }
  }
  if (options.length > 0) {
    const target = body.flat().find((line) => line.startsWith("│")) ?? null;
    return { kind: "confirm", target: target === null ? null : target.slice(1).trim(), options, highlighted: Math.max(optionHighlight, 0) };
  }

  const rows: RewindRow[] = [];
  let highlighted = -1;
  for (const block of body) {
    const first = block[0]!;
    if (/^(Enter to continue|Esc to cancel|↑|↓)/.test(first)) continue;
    if (/^Restore the code and\/or$/.test(first) || /^conversation to the point before/.test(first)) continue;
    const marked = first.startsWith("❯");
    const text = (marked ? first.slice(1) : first).trim();
    if (text === "") continue;
    if (marked) highlighted = rows.length;
    rows.push({ text, code: !block.some((line) => /No code restore/.test(line)) });
  }
  if (rows.length === 0) return null;
  return { kind: "select", rows, highlighted };
}

/** The keys that move the list's highlight from `from` to `to`, without taking anything. */
export function rewindMoves(from: number, to: number): string[] {
  const keys: string[] = [];
  const step = to < from ? "up" : "down";
  for (let move = 0; move < Math.abs(to - from); move += 1) keys.push(step);
  return keys;
}

/** The keys that move the confirm screen's highlight to `to` and take it. */
export function rewindConfirmKeys(from: number, to: number): string[] {
  const keys: string[] = [];
  const step = to < from ? "up" : "down";
  for (let move = 0; move < Math.abs(to - from); move += 1) keys.push(step);
  keys.push("enter");
  return keys;
}

/**
 * Which confirm option carries out `restore`. Claude's own wording decides, never a position: the
 * options it draws depend on whether the message has code to put back.
 */
export function rewindOptionIndex(options: readonly string[], restore: RewindRestore): number | null {
  const find = (pattern: RegExp): number | null => {
    const index = options.findIndex((label) => pattern.test(label));
    return index < 0 ? null : index;
  };
  if (restore === "both" || restore === "code") {
    const both = find(/^restore (?:the )?code and (?:the )?conversation\b/i);
    // "code" alone must not take an option that also rewrites the conversation
    const code = find(/^restore (?:the )?code\b(?!\s*(?:and|,)?\s*(?:the )?conversation)/i);
    if (restore === "code") return code;
    return both ?? code ?? find(/^restore (?:the )?conversation\b/i);
  }
  return find(/^restore (?:the )?conversation\b/i);
}

/** A point's row text and a message's first line name the same message: the dialog wraps and indents. */
export function sameRewindText(row: string, prompt: string): boolean {
  const flatten = (value: string): string => value.replace(/\s+/g, " ").replace(/…$/, "").trim();
  const a = flatten(row);
  const b = flatten(prompt);
  return a !== "" && (a === b || a.startsWith(b) || b.startsWith(a));
}

export interface OfflineRewindPlan {
  /** Where the session file is copied before it is cut. */
  backup: string;
  /** The bytes kept: everything before the chosen message. */
  keepBytes: number;
  /** Files to put back, and the recorded copy each comes from. */
  restore: { path: string; blob: string }[];
}

/**
 * What an offline rewind would do, without doing it. `sessionPath` is the Claude session JSONL and
 * `historyDir` its `file-history/<session-id>` directory of recorded file copies.
 */
export function offlineRewindPlan(
  jsonl: string,
  options: { sessionPath: string; messageId: string; historyDir: string; cwd: string; backupSuffix: string },
): OfflineRewindPlan | null {
  const lines = jsonl.split("\n");
  let offset = 0;
  let cut = -1;
  let backups: Record<string, unknown> | null = null;
  for (const line of lines) {
    const next = offset + line.length + 1;
    if (cut < 0 && line.trim() !== "") {
      let record: unknown = null;
      try {
        record = JSON.parse(line);
      } catch {
        record = null;
      }
      const entry = record !== null && typeof record === "object" ? (record as Record<string, unknown>) : null;
      if (entry !== null) {
        if (entry["type"] === "user" && entry["uuid"] === options.messageId) cut = offset;
        if (entry["type"] === "file-history-snapshot" && entry["messageId"] === options.messageId) {
          const snapshot = entry["snapshot"];
          const tracked = snapshot !== null && typeof snapshot === "object" ? (snapshot as Record<string, unknown>)["trackedFileBackups"] : null;
          if (tracked !== null && typeof tracked === "object") backups = tracked as Record<string, unknown>;
        }
      }
    }
    offset = next;
  }
  if (cut < 0) return null;
  const restore: { path: string; blob: string }[] = [];
  for (const [file, value] of Object.entries(backups ?? {})) {
    const name = typeof value === "string" ? value : value !== null && typeof value === "object" ? (value as Record<string, unknown>)["backupFileName"] : null;
    if (typeof name !== "string" || name === "") continue;
    // a recorded path outside the project is not this pane's to put back
    const target = resolvePath(options.cwd, file);
    if (!target.startsWith(`${resolvePath(options.cwd)}/`) && target !== resolvePath(options.cwd)) continue;
    restore.push({ path: target, blob: join(options.historyDir, name) });
  }
  return { backup: `${options.sessionPath}.rewind-${options.backupSuffix}.bak`, keepBytes: cut, restore };
}

/** Carries out a plan: puts the recorded files back and/or cuts the session before the message. */
export function applyOfflineRewind(
  plan: OfflineRewindPlan,
  sessionPath: string,
  options: { files?: boolean; truncate?: boolean } = {},
): { restored: string[]; missing: string[]; truncated: boolean } {
  const restored: string[] = [];
  const missing: string[] = [];
  if (options.files !== false) {
    for (const item of plan.restore) {
      if (!existsSync(item.blob)) { missing.push(item.path); continue; }
      mkdirSync(dirname(item.path), { recursive: true });
      copyFileSync(item.blob, item.path);
      restored.push(item.path);
    }
  }
  if (options.truncate === false) return { restored, missing, truncated: false };
  copyFileSync(sessionPath, plan.backup);
  const kept = readFileSync(sessionPath).subarray(0, plan.keepBytes);
  const temporary = `${sessionPath}.rewind-${process.pid}.tmp`;
  writeFileSync(temporary, kept);
  renameSync(temporary, sessionPath);
  return { restored, missing, truncated: true };
}

/** A session's `file-history` directory, beside the project's session files. */
export function claudeHistoryDir(sessionPath: string): string | null {
  const sessionId = /([^/\\]+)\.jsonl$/.exec(sessionPath)?.[1];
  if (sessionId === undefined) return null;
  const index = Math.max(sessionPath.lastIndexOf("/"), sessionPath.lastIndexOf("\\"));
  const store = index > 0 ? sessionPath.slice(0, index) : "";
  if (store === "") return null;
  // ~/.claude/projects/<slug>/<session>.jsonl -> ~/.claude/file-history/<session>
  const projects = /^(.*)[/\\]projects[/\\][^/\\]+$/.exec(store);
  if (projects === null) return null;
  return join(projects[1]!, "file-history", sessionId);
}

/** The session file's size, so a caller can tell an empty one from an unreadable one. */
export function sessionBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A resolved absolute path or null: a caller never passes a relative path into an offline restore. */
export function absolute(path: string): string | null {
  return isAbsolute(path) ? path : null;
}
