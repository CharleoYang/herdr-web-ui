import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneRead, paneSendKeys, paneSendText } from "../server/herdr/client.ts";
import { terminalOracle } from "./terminal-input-oracle.ts";
import type { TerminalInput } from "./terminal-input-oracle.ts";

const MODIFIED_CTRL_ENTER = "\x1b[27;5;13~";

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}


/**
 * Ctrl+Enter against a pane owned by the UI suite: plain Enter until the program asks for
 * modifyOtherKeys, then xterm's CSI 27;5;13~ (Claude Code's "send now"), in the browser's
 * frames and in the bytes a raw-mode program reads in the pane.
 * A mirrored pane (no terminal attach on its PC, #924) never shows the browser the program's
 * request, so there Ctrl+Enter goes as herdr's `ctrl+enter` key, which herdr encodes in the
 * program's own mode: the program reads the same bytes either way.
 */
export async function checkCtrlEnter(browser: Browser, origin: string, paneId: string): Promise<void> {
  // The same owned recorder produces OFF -> ON -> OFF before each measured action.
  const fixture = mkdtempSync(join(tmpdir(), "herdr-ctrl-enter-"));
  const received = join(fixture, "received.txt");
  const script = join(fixture, "keys.cjs");
  // Record raw bytes, not data-event boundaries; mode controls are individual ASCII bytes.
  writeFileSync(script, `const fs = require("node:fs");
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[2J\\x1b[H\\x1b[>4;0mOwned Ctrl+Enter test: initial off\\r\\n");
process.stdin.on("data", (data) => {
  fs.appendFileSync(${JSON.stringify(received)}, data);
  for (const byte of data) {
    if (byte === 3) {
      process.stdout.write("\\x1b[>4;0m");
      process.exit(0);
    }
    if (byte === 110) process.stdout.write("\\x1b[>4;2mOwned Ctrl+Enter test: modifyOtherKeys on\\r\\n");
    if (byte === 111) process.stdout.write("\\x1b[>4;0mOwned Ctrl+Enter test: final off\\r\\n");
  }
});
`);
  writeFileSync(received, "");
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  try {
    await paneSendKeys(paneId, ["ctrl+c"]);
    await paneSendText(paneId, `node ${script}`);
    await paneSendKeys(paneId, ["Enter"]);
    await until(async () => (await paneRead({ paneId, source: "visible" })).text.includes("Owned Ctrl+Enter test: initial off"), "owned raw recorder must start");
    context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
    await context.addInitScript(({ expectedOrigin, paneId }) => {
      if (location.origin !== expectedOrigin) return;
      Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-web-ui:view:${paneId}`, "terminal");
    }, { expectedOrigin: new URL(origin).origin, paneId });
    const page = await context.newPage();
    const oracle = terminalOracle(page, paneId);
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    const input = page.locator(".xterm-helper-textarea");
    await input.waitFor();
    const { mirrored } = await oracle.ready();
    const typed = (text: string): TerminalInput => ({ type: "input", pane_id: paneId, text });
    /** Ctrl+Enter's frame: herdr's key on a mirror, else what the program asked for */
    const ctrlEnter = (modified: boolean): TerminalInput => mirrored ? { type: "keys", pane_id: paneId, keys: ["ctrl+enter"] }
      : typed(modified ? MODIFIED_CTRL_ENTER : "\r");
    const screen = (text: string) => page.locator(".pane-terminal .xterm-rows", { hasText: text }).waitFor();
    // Bound the complete raw stream by the physical marker, not by an expected byte count.
    const capture = async (action: () => Promise<unknown>, label: string) => {
      const before = readFileSync(received).length;
      const frames = await oracle.measure(action);
      let bytes = Buffer.alloc(0);
      await until(() => {
        bytes = readFileSync(received).subarray(before);
        return bytes.length > 0 && bytes.at(-1) === 7;
      }, `${label}: native bytes through final physical marker`);
      return { frames, bytes };
    };
    const measure = async (action: () => Promise<unknown>, expected: TerminalInput[], bytes: string, label: string): Promise<void> => {
      const actual = await capture(action, label);
      assert.deepEqual(actual.frames, expected, `${label}: exact native frames`);
      assert.deepEqual(actual.bytes, Buffer.from(`${bytes}\x07`, "utf8"), `${label}: ordered bytes including marker, independent of data-event chunks`);
    };
    const press = (shortcut: string, expected: TerminalInput, bytes: string) => measure(() => input.press(shortcut), [expected], bytes, shortcut);
    const mode = async (control: string, rendered: string) => {
      await measure(() => input.press(control), [typed(control)], control, `mode control ${control}`);
      await screen(rendered);
      await oracle.ready();
    };
    await screen("initial off");
    await press("Control+Enter", ctrlEnter(false), "\r");
    await mode("n", "modifyOtherKeys on");
    await press("Control+Enter", ctrlEnter(true), MODIFIED_CTRL_ENTER);
    for (const [shortcut, expected] of [["Enter", "\r"], ["Shift+Enter", "\x1b\r"], ["Alt+Enter", "\x1b\r"]]) {
      await press(shortcut!, typed(expected!), expected!);
    }
    // a composition's Enter belongs to the IME
    for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      const actual = await capture(() => input.dispatchEvent("keydown", {
        key: "Enter", code: "Enter", ctrlKey: true, ...composition, bubbles: true, cancelable: true,
      }), "active IME native handling");
      assert.equal(actual.frames.some((frame) => frame.type === "input" ? frame.text.includes(MODIFIED_CTRL_ENTER)
        : frame.keys.some((key) => key.includes(MODIFIED_CTRL_ENTER) || /^(?:ctrl|control)\+enter$/i.test(key))), false,
        `an IME commit must not receive modified Ctrl+Enter; native traffic=${JSON.stringify(actual.frames)}`);
      assert.equal(actual.bytes.includes(Buffer.from(MODIFIED_CTRL_ENTER, "utf8")), false,
        `an IME commit must not produce modified Ctrl+Enter bytes; native bytes=${actual.bytes.toString("hex")}`);
    }
    // pending IME text goes before the key
    await measure(() => input.evaluate(async (element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = "";
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value = "한";
      textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
      const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: true, bubbles: true, cancelable: true };
      textarea.dispatchEvent(new KeyboardEvent("keydown", enter));
      textarea.dispatchEvent(new KeyboardEvent("keyup", enter));
    }), [typed("한"), ctrlEnter(true)], `한${MODIFIED_CTRL_ENTER}`, "pending IME text must precede Ctrl+Enter without duplicates");
    await mode("o", "final off");
    await press("Control+Enter", ctrlEnter(false), "\r");
    console.log(`PASS Ctrl+Enter stays Enter until the pane asks for modifyOtherKeys, then reaches it as CSI 27;5;13~${mirrored ? " (mirrored pane, herdr's key)" : ""}`);
    console.log("PASS Enter, Shift+Enter and Alt+Enter keep their sequences; IME text precedes Ctrl+Enter");
  } finally {
    try { await paneSendKeys(paneId, ["ctrl+c"]); }
    finally {
      try { await context?.close(); }
      finally { rmSync(fixture, { recursive: true, force: true }); }
    }
  }
}
