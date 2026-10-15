import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import type { ConversationResponse, ConversationTurn } from "../../shared/protocol.ts";
import { ConversationRefresh, type ConversationDeltaMessage } from "./conversationRefresh.ts";

const globals = globalThis as unknown as { window?: unknown };
let previousWindow: unknown;
let now = 0;
let nextTimer = 0;
const timers = new Map<number, { at: number; run: () => void }>();
const refreshers: ConversationRefresh[] = [];
let restoreClock: () => void;

beforeEach(() => {
  previousWindow = globals.window;
  now = 0; nextTimer = 0; timers.clear();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  globals.window = {
    setTimeout(run: () => void, delay: number): number {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clearTimeout(id: number | undefined): void { if (id !== undefined) timers.delete(id); },
  };
});
afterEach(() => {
  for (const refresh of refreshers.splice(0)) refresh.stop();
  restoreClock();
  globals.window = previousWindow;
});

function advance(ms: number): void {
  now += ms;
  for (const [id, timer] of [...timers]) if (timer.at <= now) {
    timers.delete(id); timer.run();
  }
}
async function settle(): Promise<void> {
  for (let step = 0; step < 20; step++) await Promise.resolve();
}
function turn(text: string, role: ConversationTurn["role"] = "assistant"): ConversationTurn {
  return { role, ts: null, parts: [{ kind: "text", text }] };
}
function frame(signature: string, base: string | null, turns = [turn(signature)]): ConversationDeltaMessage {
  return { type: "conversation-delta", pane_id: "w1:p1", signature,
    delta: { base_signature: base, source: "omp-transcript", history_id: "history-a", cursor: "c:1", turns } };
}
async function chat(pushes = true) {
  const refresh = new ConversationRefresh();
  refreshers.push(refresh);
  refresh.setPushes(pushes);
  const initial: ConversationResponse = { source: "omp-transcript", history_id: "history-a", cursor: "c:1", turns: [turn("REST user", "user"), turn("REST assistant")] };
  let authoritative = initial;
  let shown = initial;
  const reads: number[] = [];
  refresh.setRead(async (isCurrent) => {
    reads.push(now);
    if (isCurrent()) shown = authoritative;
  });
  refresh.refresh();
  await settle();
  return {
    refresh, reads, initial,
    get shown() { return shown; },
    rest(page: ConversationResponse) { authoritative = page; },
    push(message: ConversationDeltaMessage, hasHistory = false) {
      const next = refresh.replacePage(message, "w1:p1", shown, hasHistory);
      if (next !== null) shown = next;
      return next;
    },
  };
}

it("replaces every newest-page turn immediately inside the REST cooldown, without mutating its prior page", async () => {
  const view = await chat();
  advance(100);
  view.refresh.invalidate();
  const first = frame("opaque-a", "not-a-REST-digest", [turn("replacement user", "user"), turn("replacement assistant"), turn("another user", "user")]);
  expect(view.push(first)?.turns).toEqual(first.delta.turns);
  const second = frame("opaque-b", "opaque-a", [turn("one entirely new turn")]);
  expect(view.push(second)?.turns).toEqual([turn("one entirely new turn")]);
  expect(view.initial.turns).toEqual([turn("REST user", "user"), turn("REST assistant")]);
  expect(view.reads).toEqual([0]);
  expect(now).toBe(100);
});

it("ignores an already accepted opaque signature and accepts a complete empty replacement", async () => {
  const view = await chat();
  view.push(frame("first", null));
  const before = view.shown;
  expect(view.push(frame("first", "unrelated", [turn("must not overwrite duplicate")]))).toBeNull();
  expect(view.shown).toBe(before);
  expect(view.push(frame("empty", null, []))?.turns).toEqual([]);
  expect(view.reads).toEqual([0]);
});

it("rejects a known non-null base mismatch atomically, clears its baseline, and reconciles through REST", async () => {
  const view = await chat();
  advance(100);
  view.push(frame("accepted", null));
  const before = view.shown;
  expect(view.push(frame("out-of-order", "missed-frame"))).toBeNull();
  expect(view.shown).toBe(before);
  // Rejection cleared the opaque baseline; it did not bind it to the current content digest.
  expect(view.push(frame("self-contained", "unavailable-previous"))?.turns).toEqual([turn("self-contained")]);
  const authoritative = { ...view.initial, turns: [turn("authoritative REST")] };
  view.rest(authoritative);
  advance(1900); await settle();
  expect(view.shown).toBe(authoritative);
  expect(view.reads).toEqual([0, 2000]);
  expect(view.push(frame("after-REST", "unrelated-to-content"))?.turns).toEqual([turn("after-REST")]);
});

it("keeps loaded history's join stable, allowing complete replacements only with the same page start", async () => {
  const view = await chat();
  const accepted = frame("same-start", null, [turn("replacement", "user")]);
  expect(view.push(accepted, true)?.turns).toEqual(accepted.delta.turns);
  const before = view.shown;
  const moved = frame("slid", "same-start"); moved.delta.cursor = "c:2";
  expect(view.push(moved, true)).toBeNull();
  expect(view.shown).toBe(before);
  expect(view.initial.cursor).toBe("c:1");
  advance(2000); await settle();
  expect(view.reads).toEqual([0, 2000]);
});

it("allows a newest-only page start to slide and normalizes absent and null cursors to no cursor", async () => {
  const view = await chat();
  const moved = frame("slid", null); moved.delta.cursor = "c:99";
  expect(view.push(moved)?.cursor).toBe("c:99");
  const absent = frame("no-cursor", "slid"); delete absent.delta.cursor;
  expect(view.push(absent)?.cursor).toBeNull();
  const explicitNull = frame("null-cursor", "no-cursor"); explicitNull.delta.cursor = null;
  expect(view.push(explicitNull, true)?.cursor).toBeNull();
});

for (const [label, change] of [
  ["source change", (message: ConversationDeltaMessage) => { message.delta.source = "claude-transcript"; }],
  ["history change", (message: ConversationDeltaMessage) => { message.delta.history_id = "history-b"; }],
  ["history removed", (message: ConversationDeltaMessage) => { delete message.delta.history_id; }],
] as const) {
  it(`rejects ${label} and lets REST decide the new conversation`, async () => {
    const view = await chat();
    const message = frame("changed", null); change(message);
    expect(view.push(message)).toBeNull();
    expect(view.shown).toBe(view.initial);
    advance(2000); await settle();
    expect(view.reads).toEqual([0, 2000]);
  });
}

it("does not inherit a history ID when the authoritative REST page has none", async () => {
  const view = await chat();
  const noHistory = { ...view.initial }; delete noHistory.history_id;
  view.rest(noHistory); view.refresh.refresh(); await settle();
  expect(view.push(frame("present", null))).toBeNull();
  const absent = frame("absent", null); delete absent.delta.history_id;
  expect(view.push(absent)?.history_id).toBeUndefined();
});

for (const [label, delta] of [
  ["missing full page", null],
  ["missing base", { source: "omp-transcript", history_id: "history-a", turns: [] }],
  ["missing turns", { base_signature: null, source: "omp-transcript", history_id: "history-a" }],
  ["invalid turn", { base_signature: null, source: "omp-transcript", history_id: "history-a", turns: [{ role: "status", ts: null, parts: [] }] }],
  ["malformed nested tool image", { base_signature: null, source: "omp-transcript", history_id: "history-a", turns: [{ role: "assistant", ts: null, parts: [{ kind: "tool", name: "read", summary: "read", input: "", output: "", images: [{}] }] }] }],
  ["malformed nested skill", { base_signature: null, source: "omp-transcript", history_id: "history-a", turns: [{ role: "assistant", ts: null, parts: [{ kind: "skill", skill: { name: "test", evidence: ["invocation"], status: "loaded" } }] }] }],
] as const) {
  it(`rejects ${label} without changing the visible page`, async () => {
    const view = await chat();
    const message = { ...frame("malformed", null), delta } as unknown as ConversationDeltaMessage;
    expect(view.push(message)).toBeNull();
    expect(view.shown).toBe(view.initial);
    advance(2000); await settle();
    expect(view.reads).toEqual([0, 2000]);
  });
}

it("accepts every existing conversation part family without inventing a new partial-page format", async () => {
  const view = await chat();
  const message = frame("all-parts", null, [{ role: "assistant", ts: "2026-10-16T00:00:00Z", end_ts: "2026-10-16T00:00:01Z", parts: [
    { kind: "text", text: "answer", phase: "final_answer" }, { kind: "thinking", text: "thought" },
    { kind: "compact", text: "summary" }, { kind: "notice", text: "notice", source: "runtime" },
    { kind: "image", media_type: "image/png", ref: "image-1" },
    { kind: "skill", skill: { name: "review", evidence: "instructions", status: "loaded", path: "/skills/review" } },
    { kind: "tool", name: "read", summary: "file", input: "file", output: "done", error: false, arguments_omitted: true, output_ref: "output-1", output_size: 4, images: [{ media_type: "image/png", ref: "image-2" }] },
    { kind: "task_result", tasks: [{ id: "task-1", title: "Review", agent: null, model: null, status: "completed", duration_ms: 1, turns: 1, tool_calls: 0, tokens: null, result: "done", result_cut: false }] },
  ] }]);
  expect(view.push(message)?.turns).toEqual(message.delta.turns);
});

it("measures the entire serialized message in UTF-8 bytes, accepting exactly 256KiB but not one byte more", async () => {
  const view = await chat();
  const message = frame("boundary", null, [turn("")]);
  const overhead = new TextEncoder().encode(JSON.stringify(message)).byteLength;
  const remaining = 262144 - overhead;
  const text = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  message.delta.turns = [turn(text)];
  expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBe(262144);
  expect(view.push(message)?.turns).toEqual([turn(text)]);
  const before = view.shown;
  // Same-width signature isolates the byte boundary, including the routing envelope.
  const oversized = { ...message, signature: "overbyte", delta: { ...message.delta, turns: [turn(text + "x")] } };
  expect(view.push(oversized)).toBeNull();
  expect(view.shown).toBe(before);
  advance(2000); await settle();
  expect(view.reads).toEqual([0, 2000]);
});

it("drops frames during a REST reconciliation with no replay, then establishes an independent baseline", async () => {
  const view = await chat();
  view.push(frame("before", null));
  let shown = view.shown;
  const request = Promise.withResolvers<ConversationResponse>();
  view.refresh.setRead(async (isCurrent) => {
    const page = await request.promise;
    if (isCurrent()) shown = page;
  });
  view.refresh.refresh();
  expect(view.refresh.replacePage(frame("during", "before"), "w1:p1", shown, false)).toBeNull();
  const rest = { ...view.initial, turns: [turn("authoritative REST during reconciliation")] };
  request.resolve(rest); await settle();
  expect(shown).toBe(rest);
  expect(view.refresh.replacePage(frame("after", "a-base-never-observed-here"), "w1:p1", shown, false)?.turns).toEqual([turn("after")]);
});

it("fences old connection/read callbacks, drops hidden and stale-pane frames, and never replays them on resume", async () => {
  const refresh = new ConversationRefresh(); refreshers.push(refresh);
  const stale = Promise.withResolvers<void>();
  const rendered: string[] = [];
  refresh.setRead(async (isCurrent) => { await stale.promise; if (isCurrent()) rendered.push("old connection"); });
  refresh.refresh();
  refresh.resetConnection();
  refresh.setRead(async (isCurrent) => { if (isCurrent()) rendered.push("new connection"); });
  refresh.refresh();
  stale.resolve(); await settle();
  expect(rendered).toEqual(["new connection"]);
  const current: ConversationResponse = { source: "omp-transcript", history_id: "history-a", cursor: "c:1", turns: [] };
  expect(refresh.replacePage(frame("other-pane", null), "w1:p2", current, false)).toBeNull();
  expect(refresh.replacePage(frame("accepted", "not-a-local-baseline"), "w1:p1", current, false)?.turns).toEqual([turn("accepted")]);
  refresh.resetConnection();
  expect(refresh.replacePage(frame("new-connection", "not-accepted"), "w1:p1", current, false)?.turns).toEqual([turn("new-connection")]);
  refresh.stop();
  expect(refresh.replacePage(frame("hidden", "accepted"), "w1:p1", current, false)).toBeNull();
  refresh.setRead(async () => {}); refresh.refresh(); await settle();
  expect(refresh.replacePage(frame("resumed", "hidden"), "w1:p1", current, false)?.turns).toEqual([turn("resumed")]);
});

it("retains the 10s authoritative backstop with delta support and the 2s cadence without it", async () => {
  const pushed = await chat(true);
  const oldBridge = await chat(false);
  advance(1999); await settle();
  expect(oldBridge.reads).toEqual([0]);
  advance(1); await settle();
  expect(oldBridge.reads).toEqual([0, 2000]);
  expect(pushed.reads).toEqual([0]);
  pushed.push(frame("fast", null));
  advance(8000); await settle();
  expect(pushed.reads).toEqual([0, 10000]);
  expect(pushed.shown).toBe(pushed.initial);
});
