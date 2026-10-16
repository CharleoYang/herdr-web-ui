import assert from "node:assert/strict";
import type { Browser, Page, WebSocket } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneRead, paneSendKeys, paneSendText } from "../server/herdr/client.ts";

/** Observe real transport/parser progress; never classify or discard terminal replies by value. */
function terminalOracle(page: Page, paneId: string) {
  const traffic: Array<{ socket: WebSocket; direction: string; message: Record<string, unknown> }> = [];
  const inputs: Array<{ socket: WebSocket; generation: number; pane_id: string; text: string }> = [];
  const listeners = new Set<() => void>();
  let current: WebSocket | undefined;
  let generation = 0;
  let attached = false;
  let ready = false;
  let stream: string | undefined;
  let outputSeen = false;
  const pending = new Set<number>();
  const reset = () => {
    generation++; ready = false; stream = undefined; outputSeen = false; pending.clear();
  };
  const notify = () => { for (const listener of listeners) listener(); };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      traffic.push({ socket, direction: "sent", message });
      if (message.type === "input") inputs.push({ socket, generation, pane_id: message.pane_id, text: message.text });
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
          else ready = true;
        }
        if (message.type === "pty-exit" || (message.type === "error"
          && ["attach_held", "input_not_ready"].includes(message.code))) { attached = false; reset(); }
        if (message.type === "pty-data" && message.flow) {
          if (stream !== message.flow.stream_id) {
            generation++; stream = message.flow.stream_id; pending.clear(); outputSeen = false;
          }
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
      reject(new Error(`${label}; transport=${JSON.stringify(traffic.map(({ direction, message }) => ({ direction, message })))}`));
    }, 5_000);
    listeners.add(check); check();
  });
  const parsed = () => attached && ready && outputSeen && pending.size === 0;
  return {
    ready: () => until(parsed, "current terminal input and parsed bootstrap ACK required"),
    async measure(action: () => Promise<unknown>) {
      await until(parsed, "current terminal must be input-ready with all observed output parsed");
      const owner = current;
      const epoch = generation;
      const before = inputs.length;
      await action();
      // Match the existing key helper: let deferred composition sends run, then an ordered real key marker.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.locator(".xterm-helper-textarea").press("Control+g");
      await until(() => generation !== epoch || current !== owner
        || inputs.slice(before).some((frame) => frame.socket === owner && frame.generation === epoch
          && frame.pane_id === paneId && frame.text === "\x07"), "same-connection input marker required");
      assert.equal(current, owner, "key oracle must not cross a socket lifetime");
      assert.equal(generation, epoch, "key oracle must not cross an attachment lifetime");
      assert(attached && ready, "terminal must remain input-ready through the input marker");
      const frames = inputs.slice(before);
      for (const frame of frames) {
        assert.equal(frame.socket, owner, "another socket cannot supply key success");
        assert.equal(frame.generation, epoch, "an old attachment cannot supply key success");
        assert.equal(frame.pane_id, paneId, "another pane cannot supply key success");
      }
      assert.equal(frames.at(-1)?.text, "\x07", "ordered marker must end the action");
      return frames.slice(0, -1).map(({ text }) => text);
    },
  };
}

/** Mac keyboard events in an isolated context, against a pane owned by the UI suite. */
export async function checkCommandBackspace(browser: Browser, origin: string, paneId: string): Promise<void> {
  // Own the output source before either browser attaches: readline emits no terminal capability queries.
  const fixture = mkdtempSync(join(tmpdir(), "herdr-command-backspace-"));
  const result = join(fixture, "line.txt");
  const script = join(fixture, "readline.cjs");
  writeFileSync(script, `const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => process.exit(0));
process.stdout.write("\\x1b[2J\\x1b[HOwned Cmd+Backspace readline test\\r\\n");
process.stdin.on("data", (data) => {
  if (data.includes(7)) fs.writeFileSync(${JSON.stringify(result)}, rl.line);
});
`);
  try {
    await paneSendKeys(paneId, ["ctrl+c"]);
    await paneSendText(paneId, `node ${script}`);
    await paneSendKeys(paneId, ["Enter"]);
    const deadline = Date.now() + 10_000;
    while (!(await paneRead({ paneId, source: "visible" })).text.includes("Owned Cmd+Backspace readline test")) {
      if (Date.now() > deadline) throw new Error("readline fixture did not start");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
  await context.addInitScript(({ expectedOrigin, paneId }) => {
    if (location.origin !== expectedOrigin) return;
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`herdr-web-ui:view:${paneId}`, "terminal");
  }, { expectedOrigin: new URL(origin).origin, paneId });
  try {
    const page = await context.newPage();
    const oracle = terminalOracle(page, paneId);
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await oracle.ready();
    const input = page.locator(".xterm-helper-textarea");
    await input.waitFor();
    for (const [shortcut, expected] of [
      ["Backspace", "\x7f"],
      ["Meta+Backspace", "\x15"],
      ["Control+Backspace", "\b"],
      ["Alt+Backspace", "\x1b\x7f"],
      ["Meta+Shift+Backspace", "\x7f"],
      ["Meta+Alt+Backspace", "\x1b\x7f"],
      ["Meta+Control+Backspace", "\b"],
    ]) {
      assert.deepEqual(await oracle.measure(() => input.press(shortcut!)),
        [expected], `${shortcut} must send its sequence exactly once`);
    }
    // compositionend's timer is still pending when the deletion key arrives.
    const committed = await oracle.measure(() => input.evaluate(async (element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = "";
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value = "한";
      textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
      const backspace = { key: "Backspace", code: "Backspace", keyCode: 8, which: 8,
        metaKey: true, bubbles: true, cancelable: true };
      textarea.dispatchEvent(new KeyboardEvent("keydown", backspace));
      textarea.dispatchEvent(new KeyboardEvent("keyup", backspace));
    }));
    assert.deepEqual(committed,
      ["한", "\x15"],
      "pending IME text must precede line deletion without duplicates");
    for (const composition of [{ isComposing: true, keyCode: 8 }, { isComposing: false, keyCode: 229 }]) {
      const composed = await oracle.measure(() => input.dispatchEvent("keydown", {
        key: "Backspace", code: "Backspace", metaKey: true, ...composition, bubbles: true, cancelable: true,
      }));
      assert.equal(composed.includes("\x15"), false,
        "an active composition must not receive a line-deletion sequence");
    }
    // Also verify the effect in the same real, owned readline process.
      const probe = async (expected: string): Promise<void> => {
        rmSync(result, { force: true });
        await input.press("Control+g");
        const deadline = Date.now() + 5_000;
        while (!existsSync(result) || readFileSync(result, "utf8") !== expected) {
          if (Date.now() > deadline) throw new Error(`readline did not contain ${JSON.stringify(expected)}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      await input.press("Control+u");
      await probe("");
      await input.pressSequentially("remove this entire input");
      await probe("remove this entire input");
      await input.press("Meta+Backspace");
      await probe("");
    console.log("PASS Cmd+Backspace clears the entire input in a real owned readline PTY");
    console.log("PASS macOS Cmd+Backspace sends Ctrl+U once and preserves other Backspace combinations");
    console.log("PASS pending IME text precedes Cmd+Backspace without duplicates; active composition stays native");
  } finally {
    await context.close();
  }
  const nonMac = await browser.newContext();
  await nonMac.addInitScript(({ expectedOrigin, paneId }) => {
    if (location.origin !== expectedOrigin) return;
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
    localStorage.setItem(`herdr-web-ui:view:${paneId}`, "terminal");
  }, { expectedOrigin: new URL(origin).origin, paneId });
  try {
    const page = await nonMac.newPage();
    const oracle = terminalOracle(page, paneId);
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await oracle.ready();
    assert.deepEqual(await oracle.measure(() => page.locator(".xterm-helper-textarea").press("Meta+Backspace")),
      ["\x7f"], "non-macOS Meta+Backspace keeps its native sequence");
    console.log("PASS non-macOS Meta+Backspace keeps native DEL");
  } finally {
    await nonMac.close();
  }
  } finally {
    try { await paneSendKeys(paneId, ["ctrl+c"]); }
    finally { rmSync(fixture, { recursive: true, force: true }); }
  }
}
