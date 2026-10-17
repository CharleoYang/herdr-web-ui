import assert from "node:assert/strict";
import type { Page, WebSocket } from "playwright-core";

export type TerminalInput = { type: "input"; pane_id: string; text: string }
  | { type: "keys"; pane_id: string; keys: string[] };

/** Actual socket traffic only: bootstrap readiness requires xterm's stream/offset ACK. */
export function terminalOracle(page: Page, paneId: string) {
  const traffic: Array<{ socket: WebSocket; direction: string; message: Record<string, unknown> }> = [];
  const inputs: Array<{ socket: WebSocket; generation: number; message: TerminalInput }> = [];
  const listeners = new Set<() => void>();
  let current: WebSocket | undefined;
  let generation = 0;
  let attached = false;
  let inputReady = false;
  let mirrored = false;
  let stream: string | undefined;
  let outputSeen = false;
  const pending = new Set<number>();
  const reset = () => {
    generation++; inputReady = false; mirrored = false; stream = undefined; outputSeen = false; pending.clear();
  };
  const evidence = () => JSON.stringify(traffic.map(({ direction, message }) => ({ direction, message })));
  const requireInvariant = (condition: boolean, label: string) => {
    if (!condition) assert.fail(`${label}; transport=${evidence()}`);
  };
  const notify = () => { for (const listener of listeners) listener(); };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      traffic.push({ socket, direction: "sent", message });
      if (message.type === "input" || message.type === "keys") inputs.push({ socket, generation, message });
      if (message.pane_id === paneId) {
        if (message.type === "attach") { current = socket; attached = true; reset(); }
        if (socket === current && attached) {
          if (message.type === "detach") { attached = false; reset(); }
          if (message.type === "pty-ack" && message.stream_id === stream) pending.delete(message.offset);
        }
      }
      notify();
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      traffic.push({ socket, direction: "received", message });
      if (socket === current && attached && message.pane_id === paneId) {
        if (message.type === "input-ready") {
          if (message.ready === false) reset();
          else inputReady = true;
        }
        if (message.type === "pane-geometry") mirrored = message.fixed === true;
        if (message.type === "pty-exit" || (message.type === "error"
          && ["attach_held", "input_not_ready"].includes(message.code))) { attached = false; reset(); }
        if (message.type === "pty-data" && message.flow) {
          if (stream !== undefined && stream !== message.flow.stream_id) reset();
          stream = message.flow.stream_id;
          outputSeen = true;
          pending.add(message.flow.offset);
        }
      }
      notify();
    });
    socket.on("close", () => {
      if (socket === current) { attached = false; current = undefined; reset(); }
      notify();
    });
  });
  const until = (condition: () => boolean, label: string) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!condition()) return;
      clearTimeout(timer); listeners.delete(check); resolve();
    };
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`${label}; transport=${evidence()}`));
    }, 5_000);
    listeners.add(check); check();
  });
  const parsed = () => attached && inputReady && outputSeen && pending.size === 0;
  const marker = (message: TerminalInput) => message.type === "input" && message.text === "\x07";
  return {
    async ready() {
      await until(parsed, "current terminal input and parsed bootstrap ACK required");
      return { mirrored };
    },
    async measure(action: () => Promise<unknown>): Promise<TerminalInput[]> {
      await until(parsed, "current terminal must be input-ready with all observed output parsed");
      const owner = current;
      const epoch = generation;
      const before = inputs.length;
      await action();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.locator(".xterm-helper-textarea").press("Control+g");
      await until(() => generation !== epoch || current !== owner
        || inputs.slice(before).some((frame) => frame.socket === owner && frame.generation === epoch
          && frame.message.pane_id === paneId && marker(frame.message)), "same-connection input marker required");
      requireInvariant(current === owner, "key oracle crossed socket lifetime");
      requireInvariant(generation === epoch, "key oracle crossed attachment lifetime");
      requireInvariant(attached && inputReady, "terminal lost input readiness");
      const frames = inputs.slice(before);
      for (const frame of frames) {
        requireInvariant(frame.socket === owner, "foreign socket input");
        requireInvariant(frame.generation === epoch, "foreign attachment input");
        requireInvariant(frame.message.pane_id === paneId, "foreign pane input");
      }
      requireInvariant(frames.length > 0 && marker(frames.at(-1)!.message), "ordered physical marker must end action");
      return frames.slice(0, -1).map(({ message }) => message);
    },
  };
}
