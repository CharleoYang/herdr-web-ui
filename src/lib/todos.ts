import type { ConversationPart } from "../../shared/protocol.ts";
import { parseTodoAnswer, type TodoItem, type TodoStatus } from "../../shared/todos.ts";
export { parseTodoAnswer, type TodoItem, type TodoStatus } from "../../shared/todos.ts";

/**
 * The agent's todo tool calls, as the chat's work block shows them. Each agent keeps its
 * list its own way:
 * - Claude Code `TodoWrite` and Codex `update_plan` send the whole list every time;
 * - omp / omo `todo`, gjc `todo_write` (and omo's `mcp__…__todo` through Claude) send
 *   operations (init, append, start, done, drop, block, note) on one list, and answer
 *   each call with the whole list as it now stands.
 * A call reads as a one-line summary, and opened, as the list its answer shows.
 */

type Tool = Extract<ConversationPart, { kind: "tool" }>;
type Kind = "whole" | "codex-plan" | "ops";

function toolKind(name: string): Kind | null {
  if (name === "TodoWrite") return "whole";
  if (name === "update_plan") return "codex-plan";
  if (name === "todo" || name === "todo_write" || /^mcp__.+__todo$/.test(name)) return "ops";
  return null;
}

export function isTodoTool(name: string): boolean {
  return toolKind(name) !== null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function args(part: Tool): Record<string, unknown> {
  try { return record(JSON.parse(part.input)); } catch { return {}; }
}

/** The operations of one `todo` / `todo_write` call: `ops: [...]`, or the call itself as one. */
function operations(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input["ops"]) ? input["ops"].map(record) : [input];
}

function phases(list: unknown): TodoItem[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const phase = record(entry);
    const name = text(phase["phase"]);
    const items = Array.isArray(phase["items"]) ? phase["items"] : [];
    return items.flatMap((item) => text(item) === null ? [] : [{ label: text(item)!, phase: name, status: "pending" as TodoStatus }]);
  });
}

/** One line for a todo call in the work block, instead of its raw input. */
export function todoCallSummary(part: Tool): string | null {
  const kind = toolKind(part.name);
  if (kind === null) return null;
  const input = args(part);
  if (kind === "whole" || kind === "codex-plan") {
    const list = Array.isArray(input[kind === "whole" ? "todos" : "plan"]) ? input[kind === "whole" ? "todos" : "plan"] as unknown[] : [];
    const done = list.filter((entry) => record(entry)["status"] === "completed").length;
    return `${done}/${list.length} done`;
  }
  const lines = operations(input).map((op) => {
    const what = text(op["op"]) ?? (Array.isArray(op["list"]) ? "init" : "update");
    if (what === "init") {
      const items = Array.isArray(op["items"]) ? op["items"] : phases(op["list"]);
      return `plan · ${items.length} item${items.length === 1 ? "" : "s"}`;
    }
    if (what === "append") return `add · ${(Array.isArray(op["items"]) ? op["items"] : []).filter((item) => text(item) !== null).length} to ${text(op["phase"]) ?? "list"}`;
    const target = text(op["task"]) ?? text(op["phase"]);
    return target === null ? what : `${what} · ${target}`;
  });
  return lines.join(", ");
}

/** Extract todo items directly from the tool's input when the output is not yet available or lacks the list. */
export function parseTodoInput(part: Tool): TodoItem[] | null {
  const input = args(part);
  if (toolKind(part.name) === "whole" && Array.isArray(input["todos"])) {
    return input["todos"].flatMap((entry) => {
      const rec = record(entry);
      const content = text(rec["content"]);
      if (content === null) return [];
      const status: TodoStatus = rec["status"] === "completed" ? "completed"
        : rec["status"] === "in_progress" ? "in_progress"
        : rec["status"] === "blocked" ? "blocked"
        : rec["status"] === "dropped" ? "dropped"
        : "pending";
      return [{ label: content, phase: null, status }];
    });
  }
  if (toolKind(part.name) === "codex-plan" && Array.isArray(input["plan"])) {
    return input["plan"].flatMap((entry) => {
      const rec = record(entry);
      const step = text(rec["step"]);
      if (step === null) return [];
      const status: TodoStatus = rec["status"] === "completed" ? "completed"
        : rec["status"] === "in_progress" ? "in_progress"
        : rec["status"] === "blocked" ? "blocked"
        : rec["status"] === "dropped" ? "dropped"
        : "pending";
      return [{ label: step, phase: null, status }];
    });
  }
  if (toolKind(part.name) === "ops" && input["op"] === "init") {
    if (Array.isArray(input["list"])) {
      return phases(input["list"]);
    }
    if (Array.isArray(input["items"])) {
      return input["items"].flatMap((item) => {
        const str = text(item);
        return str !== null ? [{ label: str, phase: text(input["phase"]), status: "pending" as TodoStatus }] : [];
      });
    }
  }
  return null;
}

/** Returns the latest todo list state from the turn's tool calls (omp, claude, codex), or null if none was touched. */
export function turnTodos(parts: readonly ConversationPart[]): TodoItem[] | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.kind !== "tool") continue;
    if (isTodoTool(part.name) && !part.error) {
      const parsed = parseTodoAnswer(part.output);
      if (parsed !== null) return parsed;
      const fromInput = parseTodoInput(part);
      if (fromInput !== null) return fromInput;
    }
  }
  return null;
}
