import assert from "node:assert/strict";
import type { Browser, BrowserContext } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneRead, paneSendKeys, paneSendText } from "../server/herdr/client.ts";
import { terminalOracle } from "./terminal-input-oracle.ts";
import { browserEvidencePage, browserEvidenceTracing, startBrowserEvidence } from "./browser-evidence.ts";
import type { BrowserEvidenceSession } from "./browser-evidence.ts";

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
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (["input", "keys", "submit"].includes(message.type) && !panes.includes(message.pane_id)) foreign.push(message);
    }));
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
      assert.deepEqual(bytes(id, offset), Buffer.from([0x6a, 7]), `ordinary input must reach ${id} exactly once`);
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
      for (const id of panes) assert.deepEqual(bytes(id, offsets.get(id)!), Buffer.from([7]),
        `${key} must not reach either foreground; pane=${id}`);
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
