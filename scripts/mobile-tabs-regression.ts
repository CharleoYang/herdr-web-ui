import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { herdrRpc, paneSplit, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type KeyboardQA = Window & { keyboardQA: (height: number | null) => void };

const TAB_LABELS = ["second", "a long tab name for review", "deploy", "docs"];

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  }, selector);
  assert.ok(found, `${selector} is on the page`);
  return found;
}

/** The header keeps the pane's title, whatever the lens. */
async function assertShell(page: Page, label: string, titleRoom = 60): Promise<void> {
  assert.equal(await page.locator(".app-header").getByRole("button", { name: "New tab" }).count(), 0, `${label}: the header has no New tab button of its own`);
  assert.equal(await page.locator(".app-header .header-more-button").isVisible(), true, `${label}: the header keeps its More menu`);
  const title = await box(page, ".context-title-text");
  assert.ok(title.width >= titleRoom, `${label}: the pane's title keeps its room in the header (${title.width}px)`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
}


/** A phone's header, keyboard and remembered pane over a workspace with several tabs. */
export async function checkMobileTabs(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-mobile-tabs-")));
  let workspaceId: string | null = null;
  let otherWorkspaceId: string | null = null;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-mobile-tabs" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    // herdr keeps the first pane in front: the split one is seen only where the browser opens it
    const second = (await paneSplit(first, "right", false)).pane_id;
    const other = await workspaceCreate({ cwd: root, label: "ovis-test-mobile-tabs-other" });
    otherWorkspaceId = other.workspace.workspace_id;
    const panes: string[] = [];
    for (const label of TAB_LABELS) panes.push((await tabCreate({ workspaceId, cwd: root, label })).root_pane.pane_id);
    const last = panes.at(-1)!;
    await herdrRpc("pane.report_agent", { pane_id: first, source: "manual", agent: "claude", state: "idle" });

    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      const viewport = window.visualViewport!;
      let height: number | null = null;
      Object.defineProperty(viewport, "height", { get: () => height ?? window.innerHeight });
      (window as unknown as KeyboardQA).keyboardQA = (value) => { height = value; viewport.dispatchEvent(new Event("resize")); };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const evidence = process.env.UI_EVIDENCE_DIR;
    if (evidence) mkdirSync(evidence, { recursive: true });
    const screenshot = async (name: string): Promise<void> => {
      if (evidence) await page.screenshot({ path: join(evidence, `mobile-tabs-${name}.png`), animations: "disabled" });
    };

    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator('.agent-select[aria-current="true"]').waitFor({ state: "attached" });
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    const firstFrame = page.locator(`[data-layout-pane=${JSON.stringify(first)}]`);
    const composer = firstFrame.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    await assertShell(page, "chat");
    await screenshot("chat");

    await composer.tap();
    await page.evaluate(() => (window as unknown as KeyboardQA).keyboardQA(480));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard") && Math.round(document.querySelector(".app")!.getBoundingClientRect().height) === 480);
    await assertShell(page, "chat with the keyboard up");
    assert.ok((await box(page, ".composer")).bottom <= 481, "the composer stays above the keyboard");
    await screenshot("chat-keyboard");
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); (window as unknown as KeyboardQA).keyboardQA(null); });
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard"));

    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await firstFrame.locator(".key-bar").waitFor();
    assert.equal(await page.locator(".pane-frame:visible").count(), 1, "a phone shows the split tab's open pane alone");
    assert.equal(await page.locator(".pane-frame").count(), 2, "and keeps its sibling mounted");
    await assertShell(page, "terminal");

    await screenshot("terminal");

    const shown = (pane: string) => page.locator(`[data-layout-pane=${JSON.stringify(pane)}]`).waitFor({ state: "visible" });
    const selectPane = async (pane: string): Promise<void> => {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
      const agents = page.locator(".agent-section-toggle");
      if (await agents.getAttribute("aria-expanded") === "false") await agents.tap();
      const row = page.locator(`.agent-item[data-pane=${JSON.stringify(pane)}] .agent-select`);
      await row.tap();
      await page.locator(`.agent-item[data-pane=${JSON.stringify(pane)}] .agent-select[aria-current="true"]`).waitFor({ state: "attached" });
      await shown(pane);
    };
    await page.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
    await page.locator(".conn-live").waitFor();
    await shown(last);
    await page.locator('.agent-select[aria-current="true"] .agent-context', { hasText: "docs" }).waitFor({ state: "attached" });
    await assertShell(page, "the last tab");
    await screenshot("last-tab");
    await selectPane(first);
    await assertShell(page, "the first pane, tapped");

    // A workspace row opens the split pane last seen even after a phone reloads.
    await page.goto(`${origin}/?pane=${encodeURIComponent(second)}`);
    await page.locator(".conn-live").waitFor();
    await shown(second);
    await selectPane(last);
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await shown(last);
    await selectPane(second);
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).isVisible(), false, "selecting the split pane shows it without its sibling on a phone");
    await page.goto(`${origin}/?pane=${encodeURIComponent(other.root_pane.pane_id)}`);
    await page.locator(".conn-live").waitFor();
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspaceId)}] > .workspace-header .workspace-select`).tap();
    await shown(second);
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).isVisible(), false, "a workspace row picked after a reload opens the pane it was left on");

    await page.setViewportSize({ width: 320, height: 640 });
    await assertShell(page, "a 320px phone", 0);
    await screenshot("narrow");
    assert.deepEqual(errors, []);
    console.log("PASS a phone keeps the pane's title in the header in both lenses and with the keyboard up, selects panes from the sidebar, and reopens a workspace on the pane last seen after a reload");
  } finally {
    await context.close();
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    if (otherWorkspaceId) await workspaceClose(otherWorkspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-mobile-tabs-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkMobileTabs(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
