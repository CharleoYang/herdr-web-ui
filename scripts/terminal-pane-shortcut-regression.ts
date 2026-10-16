import assert from "node:assert/strict";
import type { Browser, BrowserContext, WebSocket } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneRead, paneSendKeys, paneSendText } from "../server/herdr/client.ts";
import { terminalOracle } from "./terminal-input-oracle.ts";
import { browserEvidencePage, browserEvidenceTracing, startBrowserEvidence } from "./browser-evidence.ts";
import type { BrowserEvidenceSession } from "./browser-evidence.ts";

/** Account for DA1/DECRQM replies only after this socket received the corresponding pane query. */
function terminalNegotiation(panes: string[]) {
  const replies = new Map(panes.map((pane) => [pane, [] as string[]]));
  const sockets = new WeakMap<WebSocket, Map<string, { tail: string; pending: string[] }>>();
  const state = (socket: WebSocket, pane: string) => {
    let byPane = sockets.get(socket);
    if (!byPane) { byPane = new Map(); sockets.set(socket, byPane); }
    let value = byPane.get(pane);
    if (!value) { value = { tail: "", pending: [] }; byPane.set(pane, value); }
    return value;
  };
  return {
    output(socket: WebSocket, message: Record<string, unknown>) {
      if (message.type !== "pty-data" || typeof message.pane_id !== "string"
        || !replies.has(message.pane_id) || typeof message.data !== "string") return;
      const value = state(socket, message.pane_id);
      const text = value.tail + message.data;
      for (const query of text.matchAll(/\x1b\[(?:0?c|\?(\d+)\$p)/g)) {
        if (query.index! + query[0].length > value.tail.length) value.pending.push(query[1] ?? "attributes");
      }
      value.tail = text.slice(-64);
    },
    input(socket: WebSocket, message: Record<string, unknown>) {
      if ((message.type === "attach" || message.type === "detach") && typeof message.pane_id === "string" && replies.has(message.pane_id)) {
        const value = state(socket, message.pane_id);
        value.tail = ""; value.pending = [];
        return;
      }
      if (message.type !== "input" || typeof message.pane_id !== "string"
        || !replies.has(message.pane_id) || typeof message.text !== "string") return;
      const parts = message.text.match(/\x1b\[\?(?:\d+(?:;\d+)*c|\d+;[0-4]\$y)/g);
      if (!parts || parts.join("") !== message.text) return;
      const value = state(socket, message.pane_id);
      const pending = value.pending.slice();
      for (const part of parts) {
        const kind = part.endsWith("c") ? "attributes" : /^\x1b\[\?(\d+);/.exec(part)![1]!;
        const index = pending.indexOf(kind);
        if (index < 0) return;
        pending.splice(index, 1);
      }
      value.pending = pending;
      replies.get(message.pane_id)!.push(...parts);
    },
    userBytes(pane: string, raw: Buffer): Buffer {
      const remaining = replies.get(pane)!.map((text) => Buffer.from(text));
      const user: number[] = [];
      for (let at = 0; at < raw.length;) {
        const index = remaining.findIndex((reply) => raw.subarray(at, at + reply.length).equals(reply));
        if (index < 0) user.push(raw[at++]!);
        else { at += remaining[index]!.length; remaining.splice(index, 1); }
      }
      return Buffer.from(user);
    },
  };
}
/** Switching attachments emits terminal replies, not just keys. Check the actual foreground bytes. */
export async function checkPaneShortcuts(browser: Browser, origin: string, paneA: string, paneB: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-pane-shortcut-"));
  const panes = [paneA, paneB];
  const files = new Map(panes.map((id, index) => [id, join(root, `${index}.bin`)]));
  const headers = new Map(panes.map((id) => [id, `Owned pane shortcut ${id}`]));
  const started: string[] = [];
  let context: BrowserContext | undefined;
  let evidence: BrowserEvidenceSession | undefined;
  const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const bytes = (id: string, offset: number) => readFileSync(files.get(id)!).subarray(offset);
  const length = (id: string) => readFileSync(files.get(id)!).length;
  const negotiation = terminalNegotiation(panes);
  const expected = new Map(panes.map((id) => [id, [] as number[]]));
  const assertForeground = (id: string, added: number[], label: string) => {
    expected.get(id)!.push(...added);
    assert.deepEqual(negotiation.userBytes(id, bytes(id, 0)), Buffer.from(expected.get(id)!), label);
  };
  try {
    for (const [index, id] of panes.entries()) {
      const script = join(root, `${index}.cjs`);
      writeFileSync(files.get(id)!, "");
      writeFileSync(script, `const fs = require("node:fs");
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[2J\\x1b[H\\x1b[>4;0m" + ${JSON.stringify(headers.get(id))} + "\\r\\n");
process.stdin.on("data", data => {
  fs.appendFileSync(${JSON.stringify(files.get(id))}, data);
  if (data.includes(3)) process.exit(0);
});
`);
      started.push(id);
      await paneSendKeys(id, ["ctrl+c"]);
      await paneSendText(id, `node '${script.replaceAll("'", "'\\''")}'`);
      await paneSendKeys(id, ["Enter"]);
      await until(async () => (await paneRead({ paneId: id, source: "visible" })).text.includes(headers.get(id)!), `raw foreground ${id}`);
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(({ origin, panes }) => {
      if (location.origin !== origin) return;
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      for (const id of panes) localStorage.setItem(`herdr-web-ui:view:${id}`, "terminal");
    }, { origin: new URL(origin).origin, panes });
    const page = await context.newPage();
    evidence = await startBrowserEvidence({
      page: browserEvidencePage(page), tracing: browserEvidenceTracing(context),
      directory: process.env.CHECK_BROWSER_EVIDENCE_DIR, script: "ui-regression",
      scenario: "terminal-pane-shortcuts", trace: process.env.CHECK_BROWSER_EVIDENCE_TRACE === "1",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const oracles = new Map(panes.map((id) => [id, terminalOracle(page, id)]));
    // Keep foreign-pane traffic visible; native files account for every byte in the two owned targets.
    const foreign: unknown[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => negotiation.output(socket, JSON.parse(String(payload))));
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        negotiation.input(socket, message);
        if (["input", "keys", "submit"].includes(message.type) && !panes.includes(message.pane_id)) foreign.push(message);
      });
    });
    const selected = async () => (await page.locator(".pane-item.is-selected .pane-select").getAttribute("title"))?.split(" — ")[0];
    const input = page.locator(".pane-frame.is-current .xterm-helper-textarea");
    const focus = async (id: string) => {
      await until(async () => (await selected()) === id, `selected ${id}`);
      await oracles.get(id)!.ready();
      await page.locator(".pane-frame.is-current .xterm-rows", { hasText: headers.get(id)! }).waitFor();
      await until(async () => {
        await input.focus();
        return page.evaluate(() => new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
          resolve(document.activeElement?.classList.contains("xterm-helper-textarea") ?? false)))));
      }, `stable terminal focus ${id}`);
    };
    const choose = async (id: string) => {
      if ((await selected()) !== id) await page.locator(`.pane-select[title^="${id} —"]`).click();
      await focus(id);
    };
    const marker = async (id: string, offset: number) => {
      await focus(id);
      await page.keyboard.press("Control+g");
      await until(() => bytes(id, offset).at(-1) === 7, `physical marker reached foreground ${id}`);
    };
    const positive = async (id: string) => {
      await choose(id);
      const offset = length(id);
      await page.keyboard.press("j");
      await marker(id, offset);
      assertForeground(id, [0x6a, 7], `ordinary input must reach ${id} exactly once`);
    };
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
    await positive(paneA);
    for (const [key, source, target] of [
      ["ControlOrMeta+Shift+ArrowDown", paneA, paneB],
      ["ControlOrMeta+Shift+ArrowUp", paneB, paneA],
    ] as const) {
      await choose(source);
      const offsets = new Map(panes.map((id) => [id, length(id)]));
      await page.keyboard.press(key);
      await until(async () => (await selected()) === target, `${key} selects ${target}`);
      await marker(target, offsets.get(target)!);
      await choose(source);
      await marker(source, offsets.get(source)!);
      for (const id of panes) assertForeground(id, [7], `${key} must not reach either foreground; pane=${id}`);
      assert.deepEqual(foreign, [], "pane shortcuts must never send input to a foreign pane");
      await positive(target);
    }
    assert.deepEqual(errors, [], "pane shortcut browser errors");
    console.log("PASS pane shortcuts switch both ways without foreground input; ordinary typing survives each switch");
  } catch (error) {
    await evidence?.captureFailure(error);
    throw error;
  } finally {
    try { await evidence?.finish(); }
    finally {
      try { await context?.close(); }
      finally {
        try { await Promise.all(started.map((id) => paneSendKeys(id, ["ctrl+c"]))); }
        finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }
}
