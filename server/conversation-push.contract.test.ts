import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ConversationResponse, ServerMessage } from "../shared/protocol.ts";
import { ConversationMonitor } from "./conversation-monitor.ts";
import * as conversationReader from "./conversation.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { CompletionTracker } from "./completion.ts";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import * as herdrClient from "./herdr/client.ts";
import { HerdrSocket } from "../src/lib/ws.ts";
import { DeviceStore } from "./devices.ts";
import { MachineManager } from "./machines.ts";

type TestBridge = { port: number; stop: () => void };
type ConversationChanged = Extract<ServerMessage, { type: "conversation-changed" }>;
type ConversationDelta = Extract<ServerMessage, { type: "conversation-delta" }>;
type PromptPush = Extract<ServerMessage, { type: "prompt-push" }>;
type PromptState = Omit<PromptPush, "type" | "pane_id">;
// These integration tests exercise real native-file stat ticks and asynchronous herdr/WS
// lifecycles. Platform timers cannot be faked; all waits name a condition and a deadline.
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

class TranscriptSocket {
  readonly frames: ServerMessage[] = [];
  readonly ws: WebSocket;

  constructor(bridge: TestBridge, path = "/ws", cookie?: string, private readonly label = "socket") {
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
    const url = `ws://127.0.0.1:${bridge.port}${path}`;
    this.ws = cookie ? new RuntimeSocket(url, { headers: { cookie } }) : new WebSocket(url);
    this.ws.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data)) as ServerMessage));
  }

  async open(): Promise<void> {
    await until(() => {
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error(`${this.label}: upgrade refused or socket closed before authenticated snapshot`);
      return this.frames.some((frame) => frame.type === "snapshot");
    }, `${this.label}: authenticated snapshot`);
  }

  send(message: ClientMessage): void { this.ws.send(JSON.stringify(message)); }

  async waitFor(predicate: (frame: ServerMessage) => boolean, after = 0): Promise<ServerMessage> {
    let found: ServerMessage | undefined;
    await until(() => {
      found = this.frames.find((frame, index) => index >= after && predicate(frame));
      if (!found && this.label !== "socket") {
        const failure = this.frames.slice(after).find((frame) => frame.type === "error");
        if (failure?.type === "error") throw new Error(`${this.label}: ${failure.code}: ${failure.message}`);
        if (this.ws.readyState === WebSocket.CLOSED) throw new Error(`${this.label}: socket closed awaiting frame`);
      }
      return found !== undefined;
    }, `${this.label}: expected websocket frame`);
    return found!;
  }

  async changed(paneId: string, after = 0): Promise<ConversationChanged> {
    return await this.waitFor((frame) => frame.type === "conversation-changed" && frame.pane_id === paneId, after) as ConversationChanged;
  }

  async delta(paneId: string, after = 0): Promise<ConversationDelta> {
    return await this.waitFor((frame) => frame.type === "conversation-delta" && frame.pane_id === paneId, after) as ConversationDelta;
  }
}

describe("native conversation invalidation", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-conversation-push-"));
  // the omp store sits under a temporary HOME (as in omp.contract.test.ts), never the user's own
  const originalHome = process.env["HOME"];
  const sessionStore = join(root, ".omp", "agent", "sessions");
  mkdirSync(sessionStore, { recursive: true, mode: 0o700 });
  const store = mkdtempSync(join(sessionStore, "herdr-conversation-push-"));
  const path = join(store, "first.jsonl");
  const replacement = join(store, "second.jsonl");
  const bridges: TestBridge[] = [];
  const sockets: TranscriptSocket[] = [];
  const monitors = new Map<string, ConversationMonitor>();
  let bridge: TestBridge;
  let workspaceId: string;
  let paneId: string;
  let reportSeq = Date.now() * 1000;
  const originalWatch = ConversationMonitor.prototype.watch;
  const watched = spyOn(ConversationMonitor.prototype, "watch").mockImplementation(function (this: ConversationMonitor, id: string) {
    monitors.set(id, this);
    originalWatch.call(this, id);
  });

  function transcript(answer = "first answer", id = "01a0c7a1-56d9-7e20-9f08-f7a2d973bcfe"): string {
    return `${[
      { type: "session", version: 3, id, cwd: root },
      { type: "model_change", modelId: "initial-model" },
      { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Watch native changes" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  }

  async function report(file = path): Promise<void> {
    await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:omp", agent: "omp", seq: ++reportSeq, agent_session_path: file, session_start_source: "startup" });
    const binding = await herdrRpc<{ agent: { agent_session?: { kind: string; value: string } } }>("agent.get", { target: paneId });
    expect(binding.agent.agent_session).toMatchObject({ kind: "path", value: file });
  }

  async function connect(target = bridge): Promise<TranscriptSocket> {
    const socket = new TranscriptSocket(target);
    sockets.push(socket);
    await socket.open();
    return socket;
  }

  async function read(target = bridge): Promise<ConversationResponse> {
    const response = await fetch(`http://127.0.0.1:${target.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
    expect(response.status).toBe(200);
    return await response.json() as ConversationResponse;
  }

  function attach(socket: TranscriptSocket): void {
    socket.send({ type: "attach", pane_id: paneId, cols: 80, rows: 24, keep_size: true });
  }

  function watch(socket: TranscriptSocket, enabled = true, id = paneId): void {
    socket.send({ type: "conversation-watch", pane_id: id, enabled });
  }

  async function barrier(socket: TranscriptSocket, mode: "interact" | "observe" = "interact"): Promise<void> {
    const after = socket.frames.length;
    socket.send({ type: "role", mode });
    await socket.waitFor((frame) => frame.type === "role-ack" && frame.mode === mode, after);
  }

  beforeAll(async () => {
    forgetTranscriptState();
    writeFileSync(path, transcript());
    mkdirSync(join(root, "bin"));
    const executable = join(root, "bin", "omp");
    writeFileSync(executable, "#!/bin/sh\nsleep 600\n");
    chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-conversation-push" });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable}\n` });
    await until(async () => (await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "omp", "owned omp process detected");
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr:omp", agent: "omp", state: "idle", seq: ++reportSeq });
    await report();
    process.env["HOME"] = root;
    bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false });
    bridges.push(bridge);
    expect((await read()).source).toBe("omp-transcript");
  });

  afterAll(async () => {
    for (const socket of sockets) socket.ws.close();
    for (const server of bridges) server.stop();
    watched.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (workspaceId) await workspaceClose(workspaceId);
    forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("does not monitor terminal-only attachments and releases disabled interest without detaching", async () => {
    const terminal = await connect();
    const reader = await connect();
    const watchCalls = () => {
      let count = 0;
      for (const [id] of watched.mock.calls) if (id === paneId) count += 1;
      return count;
    };
    const before = watchCalls();
    attach(terminal);
    await terminal.waitFor((frame) => frame.type === "input-ready" && frame.pane_id === paneId);
    await barrier(terminal);
    expect(watchCalls()).toBe(before);
    expect(terminal.frames.some((frame) => frame.type === "conversation-changed")).toBe(false);

    attach(reader);
    await reader.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId);
    watch(reader);
    await reader.changed(paneId);
    const monitor = monitors.get(paneId)!;
    expect(monitor.size).toBe(1);
    const afterDisable = reader.frames.length;
    watch(reader, false);
    await barrier(reader, "observe");
    await reader.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId, afterDisable);
    expect(monitor.size).toBe(0);

    // Idempotent terminal attachment must not implicitly restore chat interest.
    const disabledCalls = watchCalls();
    attach(reader);
    await barrier(reader);
    expect(watchCalls()).toBe(disabledCalls);
    expect(monitor.size).toBe(0);
    const afterTerminal = terminal.frames.length;
    const afterReader = reader.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "interest-model" })}\n`);
    watch(reader);
    await reader.changed(paneId, afterReader);
    expect((await read()).metadata?.model).toBe("interest-model");
    expect(terminal.frames.slice(afterTerminal).some((frame) => frame.type === "conversation-changed")).toBe(false);

    reader.ws.close();
    await until(() => monitor.size === 0, "closing the only interested client kept no monitor");
    // The uninterested terminal is still attached, and can subscribe without attaching again.
    const after = terminal.frames.length;
    await barrier(terminal, "observe");
    await terminal.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId, after);
    watch(terminal);
    await terminal.changed(paneId);
    watch(terminal, false);
    await barrier(terminal, "observe");
    expect(monitor.size).toBe(0);
    terminal.ws.close();
  }, 30_000);

  it("rejects malformed interest and unattached enables in-band without closing the socket", async () => {
    const socket = await connect();
    const snapshot = socket.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features?.includes("conversation-watch")).toBe(true);
    for (const fields of [
      { pane_id: paneId },
      { pane_id: paneId, enabled: "true" },
      { pane_id: paneId, enabled: null },
      { enabled: true },
      { pane_id: 7, enabled: true },
      { pane_id: "", enabled: true },
      { pane_id: "   ", enabled: false },
    ]) {
      const after = socket.frames.length;
      socket.ws.send(JSON.stringify({ type: "conversation-watch", ...fields }));
      await socket.waitFor((frame) => frame.type === "error" && frame.code === "invalid_conversation_watch", after);
    }
    const after = socket.frames.length;
    watch(socket);
    await socket.waitFor((frame) => frame.type === "error" && frame.code === "not_attached", after);
    // Disabling an already released subscription is harmless.
    watch(socket, false);
    await barrier(socket, "observe");
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    socket.ws.close();
  });

  it("shares interested pane monitors, notices metadata/tear/replacement/missing/new-session writes and releases detach/close claims", async () => {
    const first = await connect();
    const second = await connect();
    const third = await connect();
    const stranger = await connect();
    attach(first);
    watch(first);
    const initial = await first.changed(paneId);
    expect(JSON.stringify(initial)).not.toContain(store);
    attach(second);
    await barrier(second, "observe");
    watch(second);
    await barrier(second, "observe");
    attach(third);
    watch(third);
    await barrier(third, "observe");
    attach(stranger);
    await stranger.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId);
    await second.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId);
    const monitor = monitors.get(paneId)!;
    expect(monitor.size).toBe(1);
    const original = await read();
    expect(original.source).toBe("omp-transcript");

    let afterFirst = first.frames.length;
    let afterSecond = second.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "changed-model" })}\n${JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low" })}\n`);
    const metadataChange = await first.changed(paneId, afterFirst);
    expect(metadataChange.signature).not.toBe(initial.signature);
    expect((await second.changed(paneId, afterSecond)).signature).toBe(metadataChange.signature);
    const metadata = await read();
    expect(metadata.metadata).toEqual({ model: "changed-model", reasoning_effort: "low" });
    expect(metadata.turns).toEqual(original.turns);

    afterFirst = first.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "appended native answer" }] } })}\n`);
    await first.changed(paneId, afterFirst);
    expect(JSON.stringify((await read()).turns)).toContain("appended native answer");

    afterFirst = first.frames.length;
    appendFileSync(path, '{"type":"model_change","modelId":"torn-model"');
    await first.changed(paneId, afterFirst);
    expect((await read()).metadata?.model).toBe("changed-model");
    afterFirst = first.frames.length;
    appendFileSync(path, `}\n${JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" })}\n`);
    await first.changed(paneId, afterFirst);
    expect((await read()).metadata).toEqual({ model: "torn-model", reasoning_effort: "medium" });

    afterFirst = first.frames.length;
    writeFileSync(path, transcript());
    await first.changed(paneId, afterFirst);
    const truncated = await read();
    expect(truncated.history_id).not.toBe(original.history_id);
    afterFirst = first.frames.length;
    expect(Buffer.byteLength(transcript("other answer"))).toBe(Buffer.byteLength(transcript()));
    writeFileSync(`${path}.new`, transcript("other answer"));
    renameSync(`${path}.new`, path);
    await first.changed(paneId, afterFirst);
    const replaced = await read();
    expect(replaced.history_id).not.toBe(truncated.history_id);
    expect(JSON.stringify(replaced.turns)).toContain("other answer");

    afterFirst = first.frames.length;
    rmSync(path);
    await first.changed(paneId, afterFirst);
    expect(await read()).toEqual({ source: "scrollback", turns: [] });
    afterFirst = first.frames.length;
    writeFileSync(path, transcript());
    await first.changed(paneId, afterFirst);
    await until(async () => (await read()).source === "omp-transcript", "the missing transcript reappeared");

    afterFirst = first.frames.length;
    writeFileSync(replacement, transcript("new session answer", "01a0c7a1-56d9-7e20-9f08-f7a2d973bcfd"));
    await report(replacement);
    await first.changed(paneId, afterFirst);
    expect(JSON.stringify((await read()).turns)).toContain("new session answer");

    // The role ACK is a frame-order barrier: detach was processed before the write.
    first.send({ type: "detach", pane_id: paneId });
    await barrier(first, "observe");
    expect(monitor.size).toBe(1);
    afterFirst = first.frames.length;
    afterSecond = second.frames.length;
    const afterThird = third.frames.length;
    appendFileSync(replacement, `${JSON.stringify({ type: "model_change", modelId: "last-model" })}\n`);
    const finalChange = await second.changed(paneId, afterSecond);
    expect((await third.changed(paneId, afterThird)).signature).toBe(finalChange.signature);
    expect(first.frames.slice(afterFirst).some((frame) => frame.type === "conversation-changed")).toBe(false);
    expect(stranger.frames.some((frame) => frame.type === "conversation-changed")).toBe(false);
    second.ws.close();
    await until(() => second.ws.readyState === WebSocket.CLOSED, "one interested client closed");
    expect(monitor.size).toBe(1);
    third.send({ type: "detach", pane_id: paneId });
    await barrier(third, "observe");
    await until(() => monitor.size === 0, "the last interest detached while terminal-only clients stayed");
    // A detached client reattaching later has no interest until it opts in again.
    const beforeReattach = first.frames.length;
    attach(first);
    await first.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId, beforeReattach);
    expect(monitor.size).toBe(0);
    first.ws.close();
    stranger.ws.close();
    third.ws.close();
  }, 60_000);

  it("discovers the first native file written after a pane was attached", async () => {
    const unwritten = join(store, "not-yet-written.jsonl");
    await report(unwritten);
    const socket = await connect();
    attach(socket);
    watch(socket);
    await socket.changed(paneId);
    const initialConversation = await read();
    expect(initialConversation.turns).toEqual([]);
    const after = socket.frames.length;
    writeFileSync(unwritten, transcript("the first newly written answer"));
    await socket.changed(paneId, after);
    const writtenConversation = await read();
    expect(JSON.stringify(writtenConversation.turns)).toContain("the first newly written answer");
    expect(writtenConversation.history_id).not.toBe(initialConversation.history_id);
    const monitor = monitors.get(paneId)!;
    socket.ws.close();
    await until(() => monitor.size === 0, "new-file monitor released after close");
    await report();
  }, 25_000);

  it("releases failed attaches, disabled/detached/closed pending interest, and stop without reviving a monitor", async () => {
    writeFileSync(path, transcript());
    await report();
    const gate = Promise.withResolvers<boolean>();
    const pending = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "pending"), sidecar: false, terminalAttach: () => gate.promise });
    bridges.push(pending);
    const socket = await connect(pending);
    attach(socket);
    watch(socket);
    await socket.changed(paneId);
    const detachedMonitor = monitors.get(paneId)!;
    socket.send({ type: "detach", pane_id: paneId });
    await barrier(socket, "observe");
    expect(detachedMonitor.size).toBe(0);
    const after = socket.frames.length;
    attach(socket);
    watch(socket);
    await socket.changed(paneId, after);
    socket.ws.close();
    await until(() => detachedMonitor.size === 0, "close cancelled the pending native monitor");
    const survivor = await connect(pending);
    attach(survivor);
    watch(survivor);
    await survivor.changed(paneId);
    watch(survivor, false);
    await barrier(survivor);
    expect(detachedMonitor.size).toBe(0);
    const beforeCompletion = survivor.frames.length;
    gate.resolve(false);
    await survivor.waitFor((frame) => frame.type === "input-ready" && frame.pane_id === paneId);
    expect(detachedMonitor.size).toBe(0);
    expect(survivor.frames.slice(beforeCompletion).some((frame) => frame.type === "conversation-changed")).toBe(false);
    watch(survivor);
    await survivor.changed(paneId, beforeCompletion);
    watch(survivor, false);
    await barrier(survivor);
    expect(detachedMonitor.size).toBe(0);
    survivor.ws.close();
    pending.stop();

    const failedGate = Promise.withResolvers<boolean>();
    const failing = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "failing"), sidecar: false, terminalAttach: () => failedGate.promise });
    bridges.push(failing);
    const failed = await connect(failing);
    const missingPane = "w999999:p999999";
    failed.send({ type: "attach", pane_id: missingPane, cols: 80, rows: 24 });
    watch(failed, true, missingPane);
    await barrier(failed);
    const failedMonitor = monitors.get(missingPane)!;
    expect(failedMonitor.size).toBe(1);
    failedGate.resolve(false);
    await failed.waitFor((frame) => frame.type === "error" && frame.code === "pane_not_found");
    expect(failedMonitor.size).toBe(0);
    const afterFailure = failed.frames.length;
    watch(failed, true, missingPane);
    await failed.waitFor((frame) => frame.type === "error" && frame.code === "not_attached", afterFailure);
    failing.stop();
    failed.ws.close();

    const stoppedGate = Promise.withResolvers<boolean>();
    const stopping = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "stopping"), sidecar: false, terminalAttach: () => stoppedGate.promise });
    bridges.push(stopping);
    const stoppedSocket = await connect(stopping);
    attach(stoppedSocket);
    watch(stoppedSocket);
    await stoppedSocket.changed(paneId);
    const stoppedMonitor = monitors.get(paneId)!;
    stopping.stop();
    expect(stoppedMonitor.size).toBe(0);
    stoppedGate.resolve(false);
    stoppedMonitor.watch(paneId);
    expect(stoppedMonitor.size).toBe(0);
  }, 45_000);

  it("continues native invalidation while another bridge holds the terminal attach slot", async () => {
    writeFileSync(path, transcript());
    await report();
    const owner = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "owner"), terminalAttach: true });
    const held = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "held"), terminalAttach: true, attachHeldRetryMs: 200 });
    bridges.push(owner, held);
    const a = await connect(owner);
    const b = await connect(held);
    attach(a);
    await a.waitFor((frame) => frame.type === "input-ready" && frame.pane_id === paneId && frame.ready !== false);
    attach(b);
    watch(b);
    await b.waitFor((frame) => frame.type === "error" && frame.code === "attach_held");
    await b.changed(paneId);
    const heldMonitor = monitors.get(paneId)!;
    const after = b.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "held-model" })}\n`);
    await b.changed(paneId, after);
    expect((await read(held)).metadata?.model).toBe("held-model");
    expect(b.frames.some((frame) => frame.type === "pty-exit")).toBe(false);
    held.stop();
    expect(heldMonitor.size).toBe(0);
    owner.stop();
    a.ws.close();
    b.ws.close();
  }, 45_000);

  it("sends complete reader pages after invalidation with connection-local bases and lifecycle resets", async () => {
    writeFileSync(path, transcript("delta initial"));
    await report();
    const first = await connect();
    const second = await connect();
    const terminal = await connect();
    const unattached = await connect();
    const snapshot = first.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features).toContain("conversation-delta");
    expect(snapshot?.type === "snapshot" && snapshot.features).toContain("prompt-push");
    attach(first);
    watch(first);
    const initial = await first.delta(paneId);
    expect(initial.delta.base_signature).toBeNull();
    attach(second);
    watch(second);
    await barrier(second);
    attach(terminal);
    await terminal.waitFor((frame) => frame.type === "input-ready");
    watch(unattached);
    await unattached.waitFor((frame) => frame.type === "error" && frame.code === "not_attached");
    let afterFirst = first.frames.length;
    let afterSecond = second.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "delta newest complete answer" }] } })}\n`);
    const newest = await first.delta(paneId, afterFirst);
    const other = await second.delta(paneId, afterSecond);
    const page = await read();
    expect(newest.delta).toEqual({ base_signature: initial.signature, source: page.source, history_id: page.history_id, cursor: page.cursor, turns: page.turns });
    expect(other.delta).toEqual({ ...newest.delta, base_signature: null });
    const changedIndex = first.frames.findIndex((frame) => frame.type === "conversation-changed" && frame.signature === newest.signature);
    expect(changedIndex).toBeGreaterThanOrEqual(afterFirst);
    expect(changedIndex).toBeLessThan(first.frames.indexOf(newest));
    expect(terminal.frames.some((frame) => frame.type === "conversation-delta")).toBe(false);
    expect(unattached.frames.some((frame) => frame.type === "conversation-delta")).toBe(false);

    watch(first, false);
    await barrier(first);
    watch(first);
    await barrier(first);
    afterFirst = first.frames.length;
    afterSecond = second.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "reset-interest" })}\n`);
    const reset = await first.delta(paneId, afterFirst);
    const continued = await second.delta(paneId, afterSecond);
    expect(reset.delta.base_signature).toBeNull();
    expect(continued.delta.base_signature).toBe(other.signature);

    first.send({ type: "detach", pane_id: paneId });
    await barrier(first);
    afterFirst = first.frames.length;
    attach(first);
    await first.waitFor((frame) => frame.type === "pane-geometry", afterFirst);
    watch(first);
    await barrier(first);
    afterFirst = first.frames.length;
    // A native reader-confirmed empty page is a replacement, not a failed read.
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "empty-session", cwd: root })}\n`);
    const empty = await first.delta(paneId, afterFirst);
    const emptyPage = await read();
    expect(emptyPage.turns).toEqual([]);
    expect(empty.delta).toEqual({ base_signature: null, source: emptyPage.source, history_id: emptyPage.history_id, cursor: emptyPage.cursor, turns: [] });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
    const etag = response.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const unchanged = await fetch(`http://127.0.0.1:${bridge.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`, { headers: { "if-none-match": etag } });
    expect(unchanged.status).toBe(304);

    const monitor = monitors.get(paneId)!;
    for (const socket of [first, second, terminal, unattached]) socket.ws.close();
    await until(() => monitor.size === 0, "delta fanout subscriptions released");
    const reconnected = await connect();
    attach(reconnected);
    watch(reconnected);
    expect((await reconnected.delta(paneId)).delta.base_signature).toBeNull();
    reconnected.ws.close();
    await until(() => monitor.size === 0, "reconnected subscription released");
  }, 45_000);

  it("serializes pane reads and rejects superseded observations and pre/post-read identity changes", async () => {
    writeFileSync(path, transcript("race initial"));
    await report();
    const socket = await connect();
    attach(socket);
    watch(socket);
    const initial = await socket.delta(paneId);
    const actualRead = conversationReader.paneConversation;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    const delayed = spyOn(conversationReader, "paneConversation").mockImplementation(async (...args) => {
      const page = await actualRead(...args);
      if (++reads === 1) { entered.resolve(); await release.promise; }
      return page;
    });
    try {
      const after = socket.frames.length;
      appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "race first" })}\n`);
      const stale = await socket.changed(paneId, after);
      await entered.promise;
      const beforeNew = socket.frames.length;
      appendFileSync(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "race authoritative newest" }] } })}\n`);
      const latest = await socket.changed(paneId, beforeNew);
      expect(reads).toBe(1);
      release.resolve();
      const accepted = await socket.delta(paneId, after);
      expect(accepted.signature).toBe(latest.signature);
      expect(accepted.delta.base_signature).toBe(initial.signature);
      expect(socket.frames.some((frame) => frame.type === "conversation-delta" && frame.signature === stale.signature)).toBe(false);
      delayed.mockRestore();
      const authoritative = await read();
      expect(accepted.delta.turns).toEqual(authoritative.turns);

      // Change the inode after the actual read, before the monitor's next stat tick.
      // The read-side identity check, rather than only newer-notification detection, must reject it.
      let replaced = false;
      const replacementRead = spyOn(conversationReader, "paneConversation").mockImplementation(async (...args) => {
        const page = await actualRead(...args);
        if (!replaced) {
          replaced = true;
          writeFileSync(`${path}.race`, transcript("post-read replacement"));
          renameSync(`${path}.race`, path);
        }
        return page;
      });
      try {
        const beforeReplace = socket.frames.length;
        appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "replace during read" })}\n`);
        const obsolete = await socket.changed(paneId, beforeReplace);
        const replacementDelta = await socket.delta(paneId, beforeReplace);
        expect(replacementDelta.signature).not.toBe(obsolete.signature);
        expect(replacementDelta.delta.base_signature).toBe(accepted.signature);
        expect(socket.frames.some((frame) => frame.type === "conversation-delta" && frame.signature === obsolete.signature)).toBe(false);
        expect(replacementDelta.delta.turns).toEqual((await read()).turns);
      } finally { replacementRead.mockRestore(); }
    } finally {
      release.resolve();
      delayed.mockRestore();
      socket.ws.close();
      await until(() => monitors.get(paneId)!.size === 0, "race subscription released");
    }
  }, 45_000);

  it("counts the complete UTF-8 envelope inclusively and never advances bases on oversize or failed reads", async () => {
    writeFileSync(path, transcript("size initial"));
    await report();
    const socket = await connect();
    attach(socket);
    watch(socket);
    let previous = await socket.delta(paneId);
    const actualRead = conversationReader.paneConversation;
    let size = 262144;
    let mode: "size" | "error" | "native" = "size";
    let reads = 0;
    const monitor = monitors.get(paneId)!;
    const actualMatch = monitor.matches.bind(monitor);
    const verified: string[] = [];
    const matching = spyOn(monitor, "matches").mockImplementation(async (id, signature) => {
      const stable = await actualMatch(id, signature);
      if (stable) verified.push(signature);
      return stable;
    });
    const sized = spyOn(conversationReader, "paneConversation").mockImplementation(async (...args) => {
      reads++;
      if (mode === "error") throw new Error("native read failed");
      const page = await actualRead(...args);
      if (mode === "native") return page;
      // A reader fixture isolates the byte gate, including JSON escaping and multibyte text.
      const text = { kind: "text" as const, text: "😀\"\\\n" };
      const turns = [{ role: "assistant" as const, ts: null, parts: [text] }];
      const envelope: ConversationDelta = { type: "conversation-delta", pane_id: paneId, signature: "x".repeat(22), delta: { base_signature: previous.signature, source: page.source, history_id: page.history_id, cursor: page.cursor, turns } };
      text.text += "x".repeat(size - Buffer.byteLength(JSON.stringify(envelope)));
      return { ...page, turns };
    });
    try {
      let after = socket.frames.length;
      appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "exact-limit" })}\n`);
      const exact = await socket.delta(paneId, after);
      expect(Buffer.byteLength(JSON.stringify(exact))).toBe(262144);
      expect(exact.delta.turns[0]!.parts[0]).toMatchObject({ kind: "text", text: expect.stringContaining("😀\"\\\n") });
      previous = exact;
      size = 262145;
      after = socket.frames.length;
      const beforeOversize = reads;
      appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "over-limit" })}\n`);
      const oversized = await socket.changed(paneId, after);
      await until(() => reads > beforeOversize, "oversized reader page attempted");
      await until(() => verified.filter((signature) => signature === oversized.signature).length === 2, "oversized complete page passed both identity gates");
      mode = "error";
      const beforeError = reads;
      appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "read-error" })}\n`);
      const failed = await socket.changed(paneId, socket.frames.indexOf(oversized) + 1);
      await until(() => reads > beforeError, "reader failure attempted");
      mode = "native";
      appendFileSync(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "after failure native answer" }] } })}\n`);
      const recovered = await socket.delta(paneId, after);
      expect(recovered.delta.base_signature).toBe(exact.signature);
      expect(recovered.delta.turns).toEqual((await read()).turns);
      for (const signature of [oversized.signature, failed.signature]) {
        expect(socket.frames.some((frame) => frame.type === "conversation-delta" && frame.signature === signature)).toBe(false);
      }
    } finally {
      sized.mockRestore();
      matching.mockRestore();
      socket.ws.close();
      await until(() => monitors.get(paneId)!.size === 0, "size subscription released");
    }
  }, 45_000);

  it("pushes authoritative idle-screen menus, changes and disappearance without transcript writes, deduplicating repeats", async () => {
    const reader = await connect();
    const terminal = await connect();
    let screen = "No menu on this valid idle screen.";
    let observations = 0;
    const actualRead = herdrClient.paneRead;
    const screens = spyOn(herdrClient, "paneRead").mockImplementation(async (...args) => {
      const result = await actualRead(...args);
      if (args[0].paneId !== paneId || args[0].source !== "detection") return result;
      observations++;
      return { ...result, text: screen };
    });
    const menu = (question: string) => `
╭─ Ask ───────────────────╮
│ ${question}             │
├─────────────────────────┤
│❯ ○ Jetson Orin          │
│  ○ RK3588               │
│  ○ Other (type your own) │
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯`;
    const promptFrames = () => reader.frames.filter((frame) => frame.type === "prompt-push");
    const oracle = async () => {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      expect(response.status).toBe(200);
      return await response.json() as PromptState;
    };
    try {
      attach(terminal);
      await terminal.waitFor((frame) => frame.type === "input-ready");
      attach(reader); watch(reader);
      const initial = await reader.waitFor((frame) => frame.type === "prompt-push");
      expect(initial).toEqual({ type: "prompt-push", pane_id: paneId, prompt: null, suggestion: null, restored: null });
      let after = reader.frames.length;
      screen = menu("Which target?");
      const appeared = await reader.waitFor((frame) => frame.type === "prompt-push" && frame.prompt !== null, after);
      expect(appeared).toEqual({ type: "prompt-push", pane_id: paneId, ...await oracle() });
      if (appeared.type !== "prompt-push") throw new Error("expected prompt frame");
      expect(appeared.prompt).toMatchObject({ kind: "question", question: "Which target?" });
      const count = promptFrames().length;
      const beforeRepeat = observations;
      await until(() => observations >= beforeRepeat + 2, "same menu observed twice");
      await barrier(reader);
      expect(promptFrames().length).toBe(count);
      after = reader.frames.length;
      screen = menu("Which board?");
      const changed = await reader.waitFor((frame) => frame.type === "prompt-push" && frame.prompt?.question === "Which board?", after);
      expect(changed).toEqual({ type: "prompt-push", pane_id: paneId, ...await oracle() });
      after = reader.frames.length;
      screen = "No menu on this valid idle screen.";
      const disappeared = await reader.waitFor((frame) => frame.type === "prompt-push" && frame.prompt === null, after);
      expect(disappeared).toEqual({ type: "prompt-push", pane_id: paneId, ...await oracle() });
      expect(terminal.frames.some((frame) => frame.type === "prompt-push")).toBe(false);
      watch(reader, false); await barrier(reader);
      const released = reader.frames.length;
      watch(reader);
      const rejoined = await reader.waitFor((frame) => frame.type === "prompt-push", released);
      expect(rejoined).toEqual(disappeared); // Fresh interest must receive even unchanged initial null.
    } finally {
      watch(reader, false); await barrier(reader);
      reader.ws.close(); terminal.ws.close();
      screens.mockRestore();
    }
  }, 30_000);

  it("states the prompt again to a client that watches again, unchanged or not", async () => {
    const reader = await connect();
    let screen = "No menu on this valid idle screen.";
    let observations = 0;
    const actualRead = herdrClient.paneRead;
    const screens = spyOn(herdrClient, "paneRead").mockImplementation(async (...args) => {
      const result = await actualRead(...args);
      if (args[0].paneId !== paneId || args[0].source !== "detection") return result;
      observations++;
      return { ...result, text: screen };
    });
    const menu = `
╭─ Ask ───────────────────╮
│ Which target?            │
├─────────────────────────┤
│❯ ○ Jetson Orin          │
│  ○ RK3588               │
│  ○ Other (type your own) │
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯`;
    const promptFrames = () => reader.frames.filter((frame) => frame.type === "prompt-push");
    try {
      attach(reader); watch(reader);
      await reader.waitFor((frame) => frame.type === "prompt-push" && frame.prompt === null);
      let after = reader.frames.length;
      screen = menu;
      const appeared = await reader.waitFor((frame) => frame.type === "prompt-push" && frame.prompt !== null, after) as PromptPush;
      const settled = promptFrames().length;
      const seen = observations;
      // the bridge keeps observing the same menu and stays quiet about it
      await until(() => observations >= seen + 2, "the same menu observed twice");
      expect(promptFrames().length).toBe(settled);
      // a client whose own view moved on (it answered this menu) watches again: it must be told
      // what the bridge sees now, even though that is exactly what it was told before
      after = reader.frames.length;
      watch(reader);
      const again = await reader.waitFor((frame) => frame.type === "prompt-push", after) as PromptPush;
      expect(again).toEqual(appeared);
    } finally {
      watch(reader, false); await barrier(reader);
      reader.ws.close();
      screens.mockRestore();
    }
  }, 30_000);

  it("matches local and real machine-relay REST plan policy without treating observe as a watch credential", async () => {
    const state = join(root, "plan-policy");
    const deviceStore = new DeviceStore(state);
    const device = deviceStore.pair(deviceStore.startPairing().code, "Watch plan", "watch")!;
    deviceStore.match(device.token);
    const cookie = `herdr_web_device=${device.token}`;
    const config = join(root, ".claude");
    const sessionId = "01a0c7a1-56d9-7e20-9f08-f7a2d973bcff";
    const project = root.replace(/[^a-zA-Z0-9]/g, "-");
    mkdirSync(join(config, "projects", project), { recursive: true });
    mkdirSync(join(config, "plans"), { recursive: true });
    const transcript = join(config, "projects", project, `${sessionId}.jsonl`);
    const planFile = join(config, "plans", "private-plan.md");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", slug: "private-plan" })}\n`);
    const fileMarker = `T04_PRIVATE_PLAN_${sessionId}`;
    writeFileSync(planFile, `# Private plan\n1. Secret step absent from the screen. ${fileMarker}\n4. Visible last step.\n`);
    const nativeScreen = join(state, "plan-screen.txt");
    writeFileSync(nativeScreen, `Ready to code?

Here is Claude's plan:
4. Visible last step.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. Tell Claude what to change
     shift+tab to approve with this feedback
`);
    const executable = join(root, "bin", "claude");
    writeFileSync(executable, `#!/bin/sh\nprintf '\\033[2J\\033[H'\ncat '${nativeScreen}'\nsleep 600\n`);
    chmodSync(executable, 0o755);
    const owned = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-plan-policy" });
    const planPane = owned.root_pane.pane_id;
    const actualEndpoint = MachineManager.prototype.endpoint;
    let upstream: TestBridge | undefined;
    let connection: TestBridge | undefined;
    let restoreEndpoint: (() => void) | undefined;
    const clients: TranscriptSocket[] = [];
    try {
      await herdrRpc("pane.send_text", { pane_id: planPane, text: `HOME='${root}' CLAUDE_CONFIG_DIR='${config}' '${executable}'\n` });
      await until(async () => (await sessionSnapshot()).panes.find((pane) => pane.pane_id === planPane)?.agent === "claude", "owned native Claude fixture detected");
      await herdrRpc("pane.report_agent_session", { pane_id: planPane, source: "herdr:claude", agent: "claude", seq: ++reportSeq, agent_session_id: sessionId, session_start_source: "startup" });
      await herdrRpc("pane.report_agent", { pane_id: planPane, source: "herdr:claude", agent: "claude", state: "blocked", seq: ++reportSeq });
      await until(async () => (await herdrClient.paneRead({ paneId: planPane, source: "detection" })).text.includes("shift+tab to approve with this feedback"), "native plan screen painted");
      upstream = createServer({ port: 0, hostname: "127.0.0.1", token: "plan-policy-upstream", stateDir: join(state, "upstream"), machines: false, terminalAttach: false });
      const upstreamPort = upstream.port;
      const endpoint = spyOn(MachineManager.prototype, "endpoint").mockImplementation(function (this: MachineManager, id) {
        return id === "plan-policy-pc" ? { url: `http://127.0.0.1:${upstreamPort}`, token: "plan-policy-upstream" } : actualEndpoint.call(this, id);
      });
      restoreEndpoint = () => endpoint.mockRestore();
      connection = createServer({ port: 0, hostname: "127.0.0.1", token: "plan-policy-owner", stateDir: state, terminalAttach: false });
      // Snapshot starts discovery but deliberately does not await transcript resolution. These
      // owner-only bootstrap sockets never attach or enable conversation interest. Prove each
      // real bridge's reader is enriched before any policy's first-interest assertion.
      for (const [target, token, name] of [
        [connection, "plan-policy-owner", "connection"],
        [upstream, "plan-policy-upstream", "private-upstream"],
      ] as const) {
        const ownerCookie = `herdr_web_token=${token}`;
        const bootstrap = new TranscriptSocket(target, "/ws", ownerCookie, `${name}/setup`);
        clients.push(bootstrap);
        await bootstrap.open();
        let last: unknown = null;
        try {
          await until(async () => {
            const response = await fetch(`http://127.0.0.1:${target.port}/api/pane/prompt?pane_id=${encodeURIComponent(planPane)}&plan=1`, { headers: { cookie: ownerCookie } });
            if (!response.ok) throw new Error(`${name}/setup: owner HTTP ${response.status}`);
            const oracle = await response.json() as PromptState;
            last = oracle;
            return oracle.prompt?.kind === "plan" && oracle.prompt.plan_file === planFile
              && oracle.prompt.body?.includes(fileMarker) === true;
          }, `${name}/setup: full-owner file enrichment`);
        } catch (error) {
          throw new Error(`${name}/setup: enrichment unavailable; last owner HTTP=${JSON.stringify(last)}`, { cause: error });
        }
      }
      for (const remote of [false, true]) {
        for (const policy of ["owner", "observe-owner", "watch", "reduced-owner"] as const) {
          const restricted = policy === "watch" || policy === "reduced-owner";
          const search = new URLSearchParams();
          if (remote) search.set("machine_id", "plan-policy-pc");
          // A watch credential's plan=1 must not elevate it. plan=0 only narrows an owner.
          search.set("plan", policy === "reduced-owner" ? "0" : "1");
          const label = `${remote ? "relay" : "local"}/${policy}/policy`;
          // Both HTTP and WS use the same source identity. Never send the owner token with watch.
          const credential = policy === "watch" ? cookie : "herdr_web_token=plan-policy-owner";
          const client = new TranscriptSocket(connection, `/ws?${search}`, credential, label);
          clients.push(client);
          try {
            await client.open();
            const authenticated = client.frames.find((frame) => frame.type === "snapshot");
            expect(authenticated).toMatchObject({ type: "snapshot", features: expect.arrayContaining(["prompt-push", "conversation-watch"]) });
            if (authenticated?.type !== "snapshot") throw new Error(`${label}: missing authenticated snapshot`);
            expect(authenticated.snapshot.panes.some((pane) => pane.pane_id === planPane && pane.agent === "claude")).toBe(true);
            if (policy === "observe-owner") await barrier(client, "observe");
            if (policy === "watch") {
              client.send({ type: "role", mode: "interact" });
              await client.waitFor((frame) => frame.type === "role-ack" && frame.mode === "observe");
            }
            client.send({ type: "attach", pane_id: planPane, cols: 80, rows: 24, keep_size: true });
            await client.waitFor((frame) => frame.type === "input-ready" && frame.pane_id === planPane);
            client.send({ type: "conversation-watch", pane_id: planPane, enabled: true });
            await barrier(client, policy === "watch" || policy === "observe-owner" ? "observe" : "interact");
            const pushed = await client.waitFor((frame) => frame.type === "prompt-push" && frame.pane_id === planPane) as PromptPush;
            expect(pushed.prompt?.kind).toBe("plan");
            const route = remote ? "/api/machines/plan-policy-pc/pane/prompt" : "/api/pane/prompt";
            const url = new URL(`http://127.0.0.1:${connection.port}${route}`);
            url.searchParams.set("pane_id", planPane);
            url.searchParams.set("plan", policy === "reduced-owner" ? "0" : "1");
            const response = await fetch(url, { headers: { cookie: credential } });
            expect(response.status).toBe(200);
            const oracle = await response.json() as PromptState;
            expect(oracle.prompt?.kind).toBe("plan");
            expect(pushed).toEqual({ type: "prompt-push", pane_id: planPane, ...oracle });
            if (restricted) {
              expect(pushed.prompt).not.toHaveProperty("plan_file");
              expect(pushed.prompt?.body).toContain("Visible last step.");
              expect(JSON.stringify(pushed)).not.toContain("Secret step");
              expect(JSON.stringify(pushed)).not.toContain(planFile);
              expect(JSON.stringify(pushed)).not.toContain(fileMarker);
            } else {
              expect(pushed.prompt?.plan_file).toBe(planFile);
              expect(pushed.prompt?.body).toContain("Secret step absent from the screen.");
              expect(pushed.prompt?.body).toContain(fileMarker);
            }
            client.ws.close();
          } catch (error) {
            throw new Error(`${label}: first-interest REST/push policy assertion failed`, { cause: error });
          }
        }
      }
    } finally {
      for (const client of clients) client.ws.close();
      connection?.stop(); upstream?.stop();
      restoreEndpoint?.();
      await workspaceClose(owned.workspace.workspace_id);
    }
  }, 45_000);

  it("discards a slow prompt read across unwatch/reattach, serializes its successor and never pushes failure as null", async () => {
    const socket = await connect();
    attach(socket);
    await socket.waitFor((frame) => frame.type === "input-ready");
    const actualRead = herdrClient.paneRead;
    const gate = Promise.withResolvers<void>();
    const successor = Promise.withResolvers<void>();
    let started = 0;
    let settled = 0;
    let active = 0;
    let maximum = 0;
    let fail = false;
    const reads = spyOn(herdrClient, "paneRead").mockImplementation(async (...args) => {
      if (args[0].paneId !== paneId || args[0].source !== "detection") return actualRead(...args);
      const number = ++started;
      maximum = Math.max(maximum, ++active);
      try {
        if (number === 1) await gate.promise;
        if (number === 2) await successor.promise;
        if (fail) throw new Error("authoritative screen temporarily unavailable");
        return { ...await actualRead(...args), text: "No menu on this valid idle screen." };
      } finally { active--; settled++; }
    });
    try {
      watch(socket);
      await until(() => started === 1, "first prompt read in flight");
      // Real-clock integration: global fake time also replaces collector/WS readiness.
      // fixed wait: a pending read must remain alone across the real bridge observation interval.
      await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
      expect(started).toBe(1);
      watch(socket, false);
      socket.send({ type: "detach", pane_id: paneId });
      await barrier(socket);
      attach(socket); watch(socket); await barrier(socket);
      expect(started).toBe(1);
      gate.resolve();
      await until(() => started === 2, "successor prompt read in flight");
      await barrier(socket);
      expect(socket.frames.some((frame) => frame.type === "prompt-push")).toBe(false);
      successor.resolve();
      await socket.waitFor((frame) => frame.type === "prompt-push");
      expect(maximum).toBe(1);
      watch(socket, false); await barrier(socket);
      fail = true;
      const after = socket.frames.length;
      const beforeFailure = settled;
      watch(socket);
      await until(() => settled > beforeFailure, "failed prompt read settled");
      await barrier(socket);
      expect(socket.frames.slice(after).some((frame) => frame.type === "prompt-push")).toBe(false);
      fail = false;
      await socket.waitFor((frame) => frame.type === "prompt-push" && frame.prompt === null, after);
      watch(socket, false); await barrier(socket);
      const beforeRelease = started;
      // A new terminal-only connection and its attach must not restart prompt observation.
      const terminal = await connect(); attach(terminal);
      await terminal.waitFor((frame) => frame.type === "input-ready");
      await barrier(terminal);
      expect(started).toBe(beforeRelease);
      terminal.ws.close();
    } finally {
      gate.resolve();
      successor.resolve();
      watch(socket, false); await barrier(socket);
      socket.ws.close();
      reads.mockRestore();
    }
  }, 30_000);

  it("does not send optional pushes on a connection that has not advertised them", async () => {
    const snapshotFailure = spyOn(CompletionTracker.prototype, "readSnapshot").mockRejectedValue(new Error("snapshot unavailable"));
    const socket = new TranscriptSocket(bridge);
    sockets.push(socket);
    try {
      await socket.waitFor((frame) => frame.type === "error" && frame.code === "snapshot_failed");
    } finally { snapshotFailure.mockRestore(); }
    expect(socket.frames.some((frame) => frame.type === "snapshot")).toBe(false);
    attach(socket);
    watch(socket);
    const after = socket.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "undeclared-push" })}\n`);
    const changed = await socket.changed(paneId, after);
    expect(changed.signature).toEqual(expect.any(String));
    expect(Object.keys(changed).sort()).toEqual(["pane_id", "signature", "type"]);
    expect(socket.frames.some((frame) => frame.type === "conversation-delta" || frame.type === "prompt-push")).toBe(false);
    watch(socket, false);
    socket.ws.close();
  }, 30_000);


  it("releases native interest when the owned pane ends and refuses a stale enable", async () => {
    const socket = await connect();
    attach(socket);
    watch(socket);
    await socket.changed(paneId);
    // interest is accepted while the attach is still being created: a pane closed before the
    // client joined answers the attach with an error, not pty-exit, so wait for the join
    await socket.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId && frame.fixed === true);
    const monitor = monitors.get(paneId)!;
    await workspaceClose(workspaceId);
    workspaceId = "";
    await socket.waitFor((frame) => frame.type === "pty-exit" && frame.pane_id === paneId);
    expect(monitor.size).toBe(0);
    const after = socket.frames.length;
    watch(socket);
    await socket.waitFor((frame) => frame.type === "error" && frame.code === "not_attached", after);
    expect(monitor.size).toBe(0);
    socket.ws.close();
  }, 25_000);
});

it("routes prompt frames only through advertised current-connection visible chat interest, retaining legacy fallback gates", () => {
  class PromptSocket extends EventTarget {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static last: PromptSocket;
    readyState = 0;
    constructor(_url: string) { super(); PromptSocket.last = this; }
    send(_data: string): void {}
    close(): void { this.readyState = 3; }
    open(): void { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    receive(message: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    disconnect(): void { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 })); }
  }
  const descriptors = new Map(["WebSocket", "window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: PromptSocket });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: globalThis });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: page });
  const client = new HerdrSocket("ws://prompt-fixture/ws");
  const received: ServerMessage[] = [];
  client.on((message) => { if (message.type === "prompt-push") received.push(message); });
  const state: ServerMessage = { type: "prompt-push", pane_id: "w1:p1", prompt: null, suggestion: "next suggestion", restored: null };
  const snapshot = (features: string[]) => ({ type: "snapshot", snapshot: { panes: [], workspaces: [], agents: [], layouts: [] }, features });
  try {
    client.connect();
    const first = PromptSocket.last; first.open();
    client.attach("w1:p1", 80, 24, true); client.watchConversation("w1:p1", true);
    first.receive(state); // Unknown snapshot must not disable REST polling or deliver prompt frames.
    expect(client.promptPushes("w1:p1")).toBe(false);
    first.receive(snapshot(["conversation-watch"])); first.receive(state);
    expect(client.promptPushes("w1:p1")).toBe(false);
    expect(received).toEqual([]);
    first.receive(snapshot(["conversation-watch", "prompt-push"]));
    expect(client.promptPushes("w1:p1")).toBe(true);
    first.receive({ ...state, pane_id: "w1:p2" });
    first.receive(state);
    page.visibilityState = "hidden"; first.receive({ ...state, suggestion: "hidden" });
    page.visibilityState = "visible";
    client.watchConversation("w1:p1", false); first.receive({ ...state, suggestion: "unwatched" });
    expect(client.promptPushes("w1:p1")).toBe(false);
    client.watchConversation("w1:p1", true);
    client.detach("w1:p1"); first.receive({ ...state, suggestion: "detached" });
    expect(client.promptPushes("w1:p1")).toBe(false);
    client.attach("w1:p1", 80, 24, true);
    first.disconnect(); client.connect();
    const fresh = PromptSocket.last; fresh.open();
    first.receive({ ...state, suggestion: "stale socket" }); fresh.receive(state);
    expect(client.promptPushes("w1:p1")).toBe(false);
    fresh.receive(snapshot(["conversation-watch"])); fresh.receive(state);
    expect(client.promptPushes("w1:p1")).toBe(false);
    fresh.receive(snapshot(["conversation-watch", "prompt-push"]));
    const reconnected = { ...state, suggestion: "reconnected" }; fresh.receive(reconnected);
    expect(received).toEqual([state, reconnected]);
  } finally {
    client.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
