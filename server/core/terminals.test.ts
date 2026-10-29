import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { ReplayBuffer } from "../output-window.ts";
import { connectionData, type Client } from "./connections.ts";
import type { PaneAttachment } from "./terminal-process.ts";
import * as terminalProcess from "./terminal-process.ts";
import * as pty from "../pty/session.ts";
import * as herdr from "../herdr/client.ts";
import type { ServerMessage } from "../../shared/protocol.ts";

let attachment: PaneAttachment;
beforeEach(() => {
  spyOn(terminalProcess, "createSpawnAttachment").mockImplementation(({ attachments }) => ({
    spawnAttachment: async (pane: string) => { attachments.set(pane, attachment); return attachment; },
  }));
});
const { createTerminalRegistry } = await import("./terminals.ts");

afterEach(() => mock.restore());

async function join({ readOnly = false, ready, recovering, times = 1, receiptResumeId, verifyResume }: { readOnly?: boolean; ready: boolean; recovering?: boolean; times?: number; receiptResumeId?: string; verifyResume?: (id: string | undefined) => void }): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
    close() {},
  } as unknown as Client;
  const replay = new ReplayBuffer(1024);
  replay.append("retained screen");
  attachment = {
    kind: "pty", ready, ...(recovering === undefined ? {} : { recovering }), cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay,
    process: { exited: Promise.resolve(), pause() {}, resume() {}, resize() {}, winch() {}, kill() {}, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
  };
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
  });
  for (let attach = 0; attach < times; attach++) await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true, receipt_resume_id: receiptResumeId });
  verifyResume?.(client.data.attached.get("p")?.receiptResumeId);
  registry.closeAttachment("p");
  registry.conversations.stop();
  return frames;
}

it("retains only a bounded opaque resume ID on an attach claim", async () => {
  const valid = crypto.randomUUID();
  for (const value of [valid, "", "not-a-resume-id", "x".repeat(4096)]) {
    await join({ ready: true, receiptResumeId: value, verifyResume: (id) => expect(id).toBe(value === valid ? valid : undefined) });
  }
});

for (const readOnly of [false, true]) for (const ready of [false, true]) {
  it(`preserves input readiness ${ready} after replay for an ${readOnly ? "observer" : "owner"} joining a shared attach`, async () => {
    const frames = await join({ readOnly, ready });
    expect(frames.filter((frame) => frame.type === "pty-data")).toEqual([
      // the joiner's replay, marked as the screen from before, byte for byte
      { type: "pty-data", pane_id: "p", data: "retained screen", replay: true },
    ]);
    // An input-ready receipt is the existing attach-complete barrier for queued input,
    // not an output-presentation notification. No early negative receipt may satisfy it.
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual(
      ready ? [{ type: "input-ready", pane_id: "p" }] : [],
    );
    if (ready) expect(frames.findIndex((frame) => frame.type === "input-ready"))
      .toBeGreaterThan(frames.findIndex((frame) => frame.type === "pty-data"));
    expect(frames.some((frame) => frame.type === "output-recovering")).toBe(false);
  });
}

for (const readOnly of [false, true]) {
  it(`tells an ${readOnly ? "observer" : "owner"} joining a recovering attach that its replay is the screen from before, once`, async () => {
    const frames = await join({ readOnly, ready: false, recovering: true, times: 2 });
    expect(frames.filter((frame) => frame.type === "output-recovering")).toEqual([{ type: "output-recovering", pane_id: "p" }]);
    expect(frames.findIndex((frame) => frame.type === "output-recovering"))
      .toBeLessThan(frames.findIndex((frame) => frame.type === "pty-data"));
    // presentation only: the queued-input barrier still waits for the attach to take
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual([]);
  });
}

const REFUSAL = "herdr: server shut down: terminal attach failed: terminal term_0 already has an attached client; retry with --takeover\r\n";
for (const [name, reads, screen] of [
  // #2255 review: an OSC's opening read released the hold, and the refusal after it was painted
  ["an OSC cut across reads before the refusal", ["\x1b[?1049h", "\x1b]", `0;title\x07${REFUSAL}`], ""],
  ["a non-CSI escape before the refusal", ["\x1b[?1049h\x1b7", `\x1b8${REFUSAL}`], ""],
  // printable screen text releases the hold at once, but a refusal after it is still never painted
  ["a refusal after the screen it released", ["\x1b[?1049h\x1b[2J\x1b[1;1Hpane text", `\r\n${REFUSAL}`], "pane text"],
] as const) {
  it(`never paints herdr's refusal: ${name}`, async () => {
    mock.restore();
    spyOn(herdr, "sessionSnapshot").mockResolvedValue({
      panes: [{ pane_id: "p", terminal_id: "term_0", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const }],
      layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
    } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>);
    spyOn(Bun, "which").mockReturnValue("/fixture/herdr");
    const attempts: pty.PtySessionOptions[] = [];
    const RealPtySession = pty.PtySession;
    mock.module("../pty/session.ts", () => ({
      PtySession: class {
        readonly exited = Promise.withResolvers<void>().promise;
        constructor(options: pty.PtySessionOptions) { attempts.push(options); }
        kill() {}
        pause() {}
        resume() {}
        resize() {}
        winch() {}
        write() { return true; }
      },
    }));
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send(raw: string) { frames.push(JSON.parse(raw)); return raw.length; }, close() {},
    } as unknown as Client;
    // a hold and a retry that never run out here: only what the reads say decides
    const registry = createTerminalRegistry({
      options: {}, clients: new Set([client]), stopped: () => false,
      terminalAttach: async () => true, holdFor: 60_000, heldRetry: 60_000, retryFor: 0, relookupFor: 5_000,
      holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
    });
    try {
      await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true });
      const attach = attempts[0];
      if (!attach) throw new Error("no attach was started");
      for (const read of reads) attach.onData(read);
      const painted = (): string => frames.flatMap((frame) => frame.type === "pty-data" ? [frame.data] : []).join("");
      // a screen is passed on before the exit, without waiting out the hold
      expect(painted().includes(screen)).toBe(true);
      expect(frames.some((frame) => frame.type === "input-ready" && frame.ready !== false)).toBe(screen !== "");
      attach.onExit(1);
      expect(painted()).not.toContain("terminal attach failed");
      expect(painted()).not.toContain("title");
      expect(frames.filter((frame) => frame.type === "error").map((frame) => frame.type === "error" && frame.code)).toEqual(["attach_held"]);
    } finally {
      registry.closeAttachment("p");
      registry.conversations.stop();
      mock.module("../pty/session.ts", () => ({ PtySession: RealPtySession }));
    }
  });
}

for (const resized of [false, true]) {
  it(`${resized ? "keeps the hold for an attach resized before its screen" : "settles an attach on its first screen"}`, async () => {
    mock.restore();
    spyOn(herdr, "sessionSnapshot").mockResolvedValue({
      panes: [{ pane_id: "p", terminal_id: "term_0", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const }],
      layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
    } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>);
    spyOn(Bun, "which").mockReturnValue("/fixture/herdr");
    const attempts: pty.PtySessionOptions[] = [];
    const RealPtySession = pty.PtySession;
    mock.module("../pty/session.ts", () => ({
      PtySession: class {
        readonly exited = Promise.withResolvers<void>().promise;
        constructor(options: pty.PtySessionOptions) { attempts.push(options); }
        kill() {}
        pause() {}
        resume() {}
        resize() {}
        winch() {}
        write() { return true; }
      },
    }));
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send(raw: string) { frames.push(JSON.parse(raw)); return raw.length; }, close() {},
    } as unknown as Client;
    const registry = createTerminalRegistry({
      options: {}, clients: new Set([client]), stopped: () => false,
      terminalAttach: async () => true, holdFor: 60_000, heldRetry: 60_000, retryFor: 0, relookupFor: 5_000,
      holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
    });
    try {
      await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24 });
      const attach = attempts[0];
      if (!attach) throw new Error("no attach was started");
      // #2255 CI: the screen herdr drew before it applied this size is not yet the pane at that size,
      // so input waits out the hold as it did before the early settle
      if (resized) await registry.terminalFrames.resize(client, { type: "resize", pane_id: "p", cols: 91, rows: 27 });
      attach.onData("\x1b[?1049h\x1b[2J\x1b[1;1Hpane text");
      expect(frames.some((frame) => frame.type === "input-ready" && frame.ready !== false)).toBe(!resized);
    } finally {
      registry.closeAttachment("p");
      registry.conversations.stop();
      mock.module("../pty/session.ts", () => ({ PtySession: RealPtySession }));
    }
  });
}

it("marks a newcomer recovering after a ready stream ends and clears it when the next attach takes", async () => {
  // Given the real process lifecycle, with only its PTY and herdr lookup controlled.
  mock.restore();
  const snapshot = (terminalId: string) => ({
    panes: [{ pane_id: "p", terminal_id: terminalId, workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const }],
    layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const lookup = Promise.withResolvers<ReturnType<typeof snapshot>>();
  spyOn(herdr, "sessionSnapshot").mockResolvedValueOnce(snapshot("old")).mockImplementation(() => lookup.promise);
  spyOn(Bun, "which").mockReturnValue("/fixture/herdr");
  const attempts: pty.PtySessionOptions[] = [];
  const restarted = Promise.withResolvers<pty.PtySessionOptions>();
  const RealPtySession = pty.PtySession;
  mock.module("../pty/session.ts", () => ({
    PtySession: class {
      private readonly exit = Promise.withResolvers<void>();
      readonly exited = this.exit.promise;
      constructor(options: pty.PtySessionOptions) {
        attempts.push(options);
        if (attempts.length === 2) restarted.resolve(options);
      }
      kill() { this.exit.resolve(); }
      pause() {}
      resume() {}
      resize() {}
      winch() {}
      write() { return true; }
    },
  }));
  const record = () => {
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send(raw: string) { frames.push(JSON.parse(raw)); return raw.length; }, close() {},
    } as unknown as Client;
    return { client, frames };
  };
  const owner = record(), recovering = record(), recovered = record();
  let ready = Promise.withResolvers<void>();
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([owner.client, recovering.client, recovered.client]), stopped: () => false,
    terminalAttach: async () => true, holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 5_000,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() { ready.resolve(); }, end() {},
  });
  const attach = { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true } as const;
  try {
    await registry.terminalFrames.attach(owner.client, attach);
    const first = attempts[0];
    if (!first) throw new Error("initial PTY was not started");
    first.onData("retained screen");
    await ready.promise;

    // When a ready stream ends, a newcomer joins before its replacement takes.
    first.onExit(0);
    await registry.terminalFrames.attach(recovering.client, attach);
    // Then the real lifecycle marks the retained screen as recovering, without readiness.
    expect(recovering.frames.filter((frame) => ["output-recovering", "pty-data", "input-ready"].includes(frame.type))).toEqual([
      { type: "output-recovering", pane_id: "p" },
      { type: "pty-data", pane_id: "p", data: "retained screen", replay: true },
    ]);

    // When herdr supplies the replacement terminal and its attach takes.
    ready = Promise.withResolvers<void>();
    lookup.resolve(snapshot("new"));
    const next = await restarted.promise;
    expect(next.args).toEqual(["terminal", "attach", "new"]);
    next.onData("current screen");
    await ready.promise;
    await registry.terminalFrames.attach(recovered.client, attach);
    // Then later newcomers get readiness and replay without a stale recovery mark.
    expect(recovered.frames.filter((frame) => ["output-recovering", "pty-data", "input-ready"].includes(frame.type))).toEqual([
      { type: "pty-data", pane_id: "p", data: "retained screencurrent screen", replay: true },
      { type: "input-ready", pane_id: "p" },
    ]);
  } finally {
    registry.closeAttachment("p");
    registry.conversations.stop();
    mock.module("../pty/session.ts", () => ({ PtySession: RealPtySession }));
  }
});
