/** Sidebar tab actions and native pane menus over the live split canvas, on owned panes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import type { PaneLayoutSnapshot, PaneSplit } from "../shared/protocol.ts";
import { paneFocus, paneRead, paneRename, paneSplit, paneZoom, sessionSnapshot, tabClose, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { sheetsSettled } from "./sheets-settled.ts";
import { routeDrained } from "./drained-route.ts";
import { chromePath } from "./chrome-path.ts";

const evidence = process.env.UI_EVIDENCE_DIR;
const frameSelector = (id: string) => `[data-layout-pane=${JSON.stringify(id)}]`;
const frame = (page: Page, id: string) => page.locator(frameSelector(id));
const screen = (page: Page, id: string) => frame(page, id).locator(".xterm-screen");

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}
async function rect(locator: Locator, label: string) {
  const found = await locator.boundingBox();
  assert.ok(found, `${label} is visible`);
  return { top: found.y, bottom: found.y + found.height, left: found.x, right: found.x + found.width, width: found.width, height: found.height };
}
async function screenshot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `tab-menu-${name}.png`), animations: "disabled" });
}
async function layout(tabId: string): Promise<PaneLayoutSnapshot> {
  const found = (await sessionSnapshot()).layouts.find((candidate) => candidate.tab_id === tabId);
  assert.ok(found, "the owned tab has a layout");
  return found;
}
async function openApp(page: Page, origin: string, paneId: string): Promise<void> {
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(`.agent-item[data-pane=${JSON.stringify(paneId)}] .agent-select[aria-current="true"]`).waitFor({ state: "attached" });
  await screen(page, paneId).waitFor();
}
// the browser's selection only: picking a pane in the web leaves herdr's focus where it is
async function currentPane(page: Page, paneId: string): Promise<void> {
  await page.locator(`${frameSelector(paneId)}.is-current`).waitFor();
}
async function openSidebar(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: "Open workspace list", exact: true });
  if (await open.isVisible()) await open.click();
  const agents = page.locator(".agent-section-toggle");
  if (await agents.getAttribute("aria-expanded") === "false") await agents.click();
}
async function selectPane(page: Page, paneId: string): Promise<void> {
  await openSidebar(page);
  await page.locator(`.agent-item[data-pane=${JSON.stringify(paneId)}] .agent-select`).click();
  await currentPane(page, paneId);
}
async function rowSheet(page: Page, paneId: string): Promise<Locator> {
  await openSidebar(page);
  await page.locator(`.agent-item[data-pane=${JSON.stringify(paneId)}] .row-menu-toggle`).tap();
  const sheet = page.locator(".row-sheet");
  await sheet.waitFor();
  await sheetsSettled(page);
  return sheet;
}
async function paneMenu(page: Page, paneId: string): Promise<Locator> {
  await screen(page, paneId).click({ button: "right", position: { x: 32, y: 32 } });
  const menu = page.getByRole("menu", { name: /^Pane actions for / });
  await menu.waitFor();
  await until(() => menu.evaluate((node) => node.contains(document.activeElement)), "the pane menu takes keyboard focus");
  return menu;
}

async function checkDesktop(browser: Browser, origin: string, first: string, second: string, tabId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    const input: Array<{ type: string; pane_id: string; text?: string; keys?: string[] }> = [];
    const attaches: string[] = [];
    const detaches: string[] = [];
    const ready = new Set<string>();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input" || message.type === "keys") input.push(message);
        if (message.type === "attach") attaches.push(message.pane_id);
        if (message.type === "detach") detaches.push(message.pane_id);
      });
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input-ready" && message.ready !== false) ready.add(message.pane_id);
      });
    });
    await paneFocus(first);
    await openApp(page, origin, first);
    await screen(page, second).waitFor();
    await until(() => ready.has(first) && ready.has(second), "both split terminals accept input");
    assert.equal(await page.locator(".pane-frame:visible").count(), 2, "both panes are shown simultaneously");
    const left = await rect(frame(page, first), "the first pane");
    const right = await rect(frame(page, second), "the second pane");
    assert.ok(left.right <= right.left + 2 && Math.abs(left.top - right.top) < 2, "the panes follow herdr's right split");
    const firstTerm = await frame(page, first).locator(".xterm").elementHandle();
    const secondTerm = await frame(page, second).locator(".xterm").elementHandle();

    // The menu remains a real Tab stop without taking Shift+F10 away from terminal programs.
    const paneButton = frame(page, first).locator(".pane-frame-menu");
    assert.equal(await paneButton.evaluate((node) => getComputedStyle(node).opacity), "0");
    await frame(page, first).focus();
    await page.keyboard.press("Tab");
    assert.equal(await paneButton.evaluate((node) => node === document.activeElement), true, "Tab reaches the pane menu");
    assert.equal(await paneButton.evaluate((node) => getComputedStyle(node).opacity), "1", "keyboard focus reveals the button");
    await screenshot(page, "keyboard-pane-button");
    await page.keyboard.press("Enter");
    const keyboardMenu = page.getByRole("menu", { name: /^Pane actions for / });
    await keyboardMenu.waitFor();
    await keyboardMenu.getByRole("menuitem", { name: "Rename pane", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await keyboardMenu.waitFor({ state: "detached" });

    // Both search bars stay mounted, but a new request must never focus the old sibling's bar.
    for (const target of [second, first]) {
      await frame(page, target).locator(".pane-frame-title").click();
      await currentPane(page, target);
      await page.keyboard.press("ControlOrMeta+Shift+F");
      await frame(page, target).locator('.find-bar input').waitFor();
    }
    assert.equal(await frame(page, first).locator('.find-bar input').evaluate((node) => node === document.activeElement), true, "search focus stays on the newly requested pane");
    for (const target of [second, first]) await frame(page, target).getByRole("button", { name: "Close search", exact: true }).click();

    // A row's context menu targets an inactive tab without selecting it; Close removes only that tab.
    const nativeTab = (await sessionSnapshot()).tabs.find((candidate) => candidate.tab_id === tabId)!;
    const target = await tabCreate({ workspaceId: nativeTab.workspace_id, label: "menu-target" });
    const inactive = page.locator(`.agent-item[data-pane=${JSON.stringify(target.root_pane.pane_id)}] .agent-select`);
    await inactive.waitFor();
    await frame(page, first).locator(".xterm-helper-textarea").focus();
    await inactive.click({ button: "right" });
    const menuForRow = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Close tab", exact: true }) });
    await menuForRow.waitFor();
    assert.equal(await page.locator(`.agent-item[data-pane=${JSON.stringify(first)}] .agent-select`).getAttribute("aria-current"), "true", "the open pane does not change when another tab's row is right-clicked");
    assert.equal((await sessionSnapshot()).focused_pane_id, first, "the menu does not change native focus");
    await page.keyboard.press("Escape");
    await menuForRow.waitFor({ state: "detached" });
    assert.equal(await frame(page, first).locator(".xterm-helper-textarea").evaluate((node) => node === document.activeElement), true, "right-click dismissal restores terminal input");
    await inactive.click({ button: "right" });
    await menuForRow.waitFor();
    const closingTab = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/tab/close"));
    await menuForRow.getByRole("menuitem", { name: "Close tab", exact: true }).click();
    const closeTabResponse = await closingTab;
    assert.equal(closeTabResponse.status(), 200);
    assert.deepEqual(closeTabResponse.request().postDataJSON(), { tab_id: target.tab.tab_id });
    await inactive.waitFor({ state: "detached" });
    await currentPane(page, first);
    assert.equal((await sessionSnapshot()).tabs.filter((tab) => tab.workspace_id === nativeTab.workspace_id).length, 1, "closing an inactive tab preserves the original tab");

    // An inactive pane is a menu target, not a focus change. Menu arrows and Escape never type.
    await frame(page, first).locator(".xterm-helper-textarea").focus();
    await currentPane(page, first);
    const beforeMenuInput = input.length;
    assert.equal(await frame(page, second).locator(".pane-frame-menu").evaluate((node) => getComputedStyle(node).opacity), "0", "the pane ellipsis stays visually hidden without keyboard focus");
    let menu = await paneMenu(page, second);
    assert.equal(await frame(page, first).evaluate((node) => node.classList.contains("is-current")), true);
    assert.equal((await sessionSnapshot()).focused_pane_id, first, "right-click leaves native focus on the first pane");
    await menu.getByRole("menuitem", { name: "Swap with focused pane", exact: true }).waitFor();
    const menuBox = await rect(menu, "the pane menu");
    assert.ok(menuBox.left >= 0 && menuBox.right <= 1280 && menuBox.top >= 0 && menuBox.bottom <= 800, "the pointer menu stays inside the screen");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await frame(page, first).locator(".xterm-helper-textarea").evaluate((node) => node === document.activeElement), true, "Escape restores the previous input focus");
    // Moving the pointer onto a mouse-reporting app can produce an unpressed SGR motion
    // before the right click. The menu must intercept presses, releases and keyboard input.
    const menuInput = input.slice(beforeMenuInput).filter((message) => message.type !== "input" || !/^\x1b\[<35;\d+;\d+M$/.test(message.text ?? ""));
    assert.deepEqual(menuInput, [], "opening and navigating a pane menu sends no button or keyboard input");

    if (process.platform === "darwin") {
      await frame(page, second).locator(".pane-frame-head").click({ modifiers: ["Control"] });
      menu = page.getByRole("menu", { name: /^Pane actions for / });
      await menu.waitFor();
      assert.equal((await sessionSnapshot()).focused_pane_id, first, "Mac Control-click preserves native focus");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    }

    menu = await paneMenu(page, second);
    const swap = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pane/swap"));
    await menu.getByRole("menuitem", { name: "Swap with focused pane", exact: true }).click();
    const swapped = await swap;
    assert.equal(swapped.status(), 200);
    assert.deepEqual(swapped.request().postDataJSON(), { pane_id: first, target_pane_id: second });
    await until(async () => (await rect(frame(page, first), "first after swap")).left > (await rect(frame(page, second), "second after swap")).left, "the actual pane contents swap positions");
    await currentPane(page, first);

    // Real shell output proves input is addressed to the clicked pane, not merely painted there.
    for (const [target, other, marker] of [[first, second, "CANVAS_FIRST_INPUT"], [second, first, "CANVAS_SECOND_INPUT"]] as const) {
      await frame(page, target).locator(".pane-frame-title").click();
      await currentPane(page, target);
      assert.equal(await frame(page, target).locator(".xterm-helper-textarea").evaluate((node) => node === document.activeElement), true, "a frame title selects its terminal for typing");
      const start = input.length;
      await page.keyboard.type(`printf '${marker}\\n'`);
      await page.keyboard.press("Enter");
      await until(async () => (await paneRead({ paneId: target, source: "visible" })).text.includes(marker), `the target shell received ${marker}`);
      await until(() => input.slice(start).some((message) => message.pane_id === target), "the typed frames are observed");
      assert.ok(input.slice(start).every((message) => message.pane_id === target), "every typed frame belongs to the target pane");
      assert.equal((await paneRead({ paneId: other, source: "visible" })).text.includes(marker), false, "the sibling shell receives none of the marker");
    }

    menu = await paneMenu(page, second);
    const splitting = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pane/split"));
    await menu.getByRole("menuitem", { name: "Split down", exact: true }).click();
    const splitResponse = await splitting;
    assert.equal(splitResponse.status(), 200);
    assert.deepEqual(splitResponse.request().postDataJSON(), { pane_id: second, direction: "down", focus: true });
    const third = ((await splitResponse.json()) as PaneSplit).pane.pane_id;
    await screen(page, third).waitFor();
    await until(() => ready.has(third), "the newly split terminal accepts input");
    await currentPane(page, third);
    assert.equal(await page.locator(".pane-frame:visible").count(), 3, "a split adds a live third pane");
    assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true, "splitting keeps the first terminal mounted");
    assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true, "splitting keeps the second terminal mounted");

    const vertical = page.locator('.pane-divider[aria-orientation="vertical"]');
    assert.equal(await page.getByRole("separator", { name: "Resize split", exact: true }).count(), 2);
    const beforeRatio = (await layout(tabId)).splits.find((split) => /_root$/.test(split.id))!.ratio;
    const grip = await rect(vertical, "the root divider");
    const canvas = await rect(page.locator(".pane-canvas"), "the canvas");
    const movedRatio = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/layout/ratio"));
    // Avoid the horizontal divider's intersection with this vertical root divider.
    await page.mouse.move(grip.left + grip.width / 2, grip.top + grip.height / 4);
    await page.mouse.down();
    await page.mouse.move(grip.left + grip.width / 2 + canvas.width * 0.12, grip.top + grip.height / 4, { steps: 5 });
    await page.mouse.up();
    const ratioResponse = await movedRatio;
    assert.equal(ratioResponse.status(), 200);
    assert.deepEqual(ratioResponse.request().postDataJSON().path, []);
    await until(async () => (await layout(tabId)).splits.find((split) => /_root$/.test(split.id))!.ratio > beforeRatio + 0.08, "divider dragging changes herdr's root ratio");
    await until(async () => Number(await vertical.getAttribute("aria-valuenow")) > Math.round(beforeRatio * 100) + 8, "the visible divider follows herdr");
    await screenshot(page, "canvas-three-panes");

    const attachedBeforeZoom = attaches.length;
    const detachedBeforeZoom = detaches.length;
    menu = await paneMenu(page, third);
    await menu.getByRole("menuitem", { name: "Zoom pane", exact: true }).click();
    await until(async () => (await layout(tabId)).zoomed && await page.locator(".pane-frame:visible").count() === 1, "the selected pane zooms");
    await currentPane(page, third);
    assert.equal(await page.locator(".pane-frame").count(), 3, "zoom keeps sibling mounts");
    assert.equal(await page.locator(".pane-divider").count(), 0, "zoom hides split dividers");
    menu = await paneMenu(page, third);
    await menu.getByRole("menuitem", { name: "Unzoom pane", exact: true }).click();
    await until(async () => !(await layout(tabId)).zoomed && await page.locator(".pane-frame:visible").count() === 3, "unzoom restores the split canvas");
    await currentPane(page, third);
    assert.equal(attaches.length, attachedBeforeZoom, "zoom does not reattach terminals");
    assert.equal(detaches.length, detachedBeforeZoom, "zoom does not detach sibling terminals");
    assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true);
    assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true);
    // A closed selected pane is absent from the roster before App's confirmation read answers.
    // Keep that read pending: the surviving terminals must not disappear or lose their leases.
    let releaseSelection!: () => void;
    const selectionGate = new Promise<void>((resolve) => { releaseSelection = resolve; });
    let selectionReads = 0;
    const unrouteSelection = await routeDrained(page, "**/api/session", async (route) => {
      selectionReads += 1;
      const response = await route.fetch();
      await selectionGate;
      await route.fulfill({ response });
    });
    const survivingAttaches = () => attaches.filter((id) => id === first || id === second).length;
    const survivingDetaches = () => detaches.filter((id) => id === first || id === second).length;
    const beforeCloseAttaches = survivingAttaches();
    const beforeCloseDetaches = survivingDetaches();
    try {
      menu = await paneMenu(page, third);
      await menu.getByRole("menuitem", { name: "Close pane", exact: true }).click();
      await frame(page, third).waitFor({ state: "detached" });
      await until(() => selectionReads > 0, "the missing selected pane awaits confirmation");
      await page.locator('.pane-canvas[aria-busy="true"]').waitFor();
      assert.equal(await page.locator(".pane-frame:visible").count(), 2, "closing a pane keeps the surviving split while selection is pending");
      assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true, "the first sibling survives the pending selection");
      assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true, "the second sibling survives the pending selection");
      assert.equal(survivingAttaches(), beforeCloseAttaches, "the surviving panes do not reattach while selection is pending");
      assert.equal(survivingDetaches(), beforeCloseDetaches, "the surviving panes do not detach while selection is pending");
      releaseSelection();
      await page.locator('.pane-canvas[aria-busy="true"]').waitFor({ state: "detached" });
      const focused = (await layout(tabId)).focused_pane_id;
      assert.ok(focused === first || focused === second, "herdr selects a surviving sibling");
      await currentPane(page, focused);
      assert.equal(await page.locator(".pane-frame:visible").count(), 2, "closing a pane restores the surviving split");
      assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true, "the first terminal remains the same after confirmation");
      assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true, "the second terminal remains the same after confirmation");
      assert.equal(survivingAttaches(), beforeCloseAttaches);
      assert.equal(survivingDetaches(), beforeCloseDetaches);
    } finally {
      releaseSelection();
      await unrouteSelection();
      await firstTerm?.dispose();
      await secondTerm?.dispose();
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function checkPhone(browser: Browser, origin: string, first: string, second: string, viewport: { width: number; height: number }): Promise<void> {
  // Opening a pane URL restores the browser selection; it does not change herdr focus.
  await paneFocus(first);
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openApp(page, origin, first);
    await screen(page, second).waitFor({ state: "attached" });
    assert.equal(await page.locator(".pane-frame:visible").count(), 1, "a phone shows the split tab's open pane alone");
    assert.equal(await frame(page, first).isVisible(), true, "the open pane is the one shown");
    assert.equal(await page.locator(".pane-frame").count(), 2, "its sibling stays mounted");
    assert.equal(await page.locator(".pane-divider").count(), 0, "a phone draws no split boundary");
    await selectPane(page, second);
    await until(async () => await frame(page, second).isVisible() && !(await frame(page, first).isVisible()), "the picked pane replaces the open one");
    assert.equal((await sessionSnapshot()).layouts.find((entry) => entry.panes.some((pane) => pane.pane_id === first))?.zoomed, false, "showing one pane on a phone does not zoom herdr's layout");
    await selectPane(page, first);
    let tabSheet = await rowSheet(page, first);
    const sheetBox = await rect(tabSheet, "the phone row menu");
    assert.ok(sheetBox.top >= 0 && sheetBox.bottom <= viewport.height + 1);
    await tabSheet.getByRole("button", { name: "Cancel", exact: true }).tap();
    await tabSheet.waitFor({ state: "detached" });
    const owner = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === first)!;
    const sibling = await tabCreate({ workspaceId: owner.workspace_id, label: "touch-reorder" });
    const siblingRow = page.locator(`.agent-item[data-pane=${JSON.stringify(sibling.root_pane.pane_id)}]`);
    try {
      await siblingRow.waitFor();
      tabSheet = await rowSheet(page, first);
      await tabSheet.getByRole("button", { name: "Move tab right", exact: true }).tap();
      await until(async () => (await sessionSnapshot()).tabs.filter((entry) => entry.workspace_id === owner.workspace_id)[0]?.tab_id === sibling.tab.tab_id, "touch row menu reorders native tabs");
      await currentPane(page, first);
      tabSheet = await rowSheet(page, first);
      await tabSheet.getByRole("button", { name: "Move tab left", exact: true }).tap();
      await until(async () => (await sessionSnapshot()).tabs.filter((entry) => entry.workspace_id === owner.workspace_id)[0]?.tab_id === owner.tab_id, "touch row menu restores original order");
    } finally { await tabClose(sibling.tab.tab_id); }
    await siblingRow.waitFor({ state: "detached" });
    tabSheet = await rowSheet(page, first);
    const cancel = tabSheet.getByRole("button", { name: "Cancel", exact: true });
    assert.ok((await rect(cancel, "Cancel")).bottom <= viewport.height + 1, "Cancel remains reachable");
    await tabSheet.locator(".row-sheet-items").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const close = tabSheet.getByRole("button", { name: "Close tab", exact: true });
    assert.ok((await rect(close, "Close tab")).bottom <= (await rect(cancel, "Cancel")).top + 1, "the menu's last action is reachable after scrolling");
    await screenshot(page, `canvas-phone-${viewport.width}`);
    await cancel.tap();
    await tabSheet.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Close workspace list", exact: true }).tap();
    // A zoom originating in another client must be reversible from the phone's pane menu.
    await paneZoom(first, "on");
    const touchMenu = frame(page, first).locator(".pane-frame-menu");
    const touchBox = await rect(touchMenu, "the pane's touch menu button");
    assert.ok(touchBox.width >= 40 && touchBox.height >= 40, "the menu button remains a touch-sized target");
    await touchMenu.tap();
    const paneSheet = page.getByRole("dialog", { name: /^Pane actions for / });
    await paneSheet.waitFor();
    const unzoom = paneSheet.getByRole("button", { name: "Unzoom pane", exact: true });
    await unzoom.waitFor();
    await sheetsSettled(page);
    await screenshot(page, `unzoom-phone-${viewport.width}`);
    const unzoomed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pane/zoom"));
    await unzoom.tap();
    assert.equal((await unzoomed).status(), 200);
    await paneSheet.waitFor({ state: "detached" });
    await until(async () => !(await layout(owner.tab_id)).zoomed, "the native layout is unzoomed");
    // As before the strip removal, wait for the browser's unzoomed snapshot, not only the HTTP ACK.
    await touchMenu.tap();
    await paneSheet.waitFor();
    await unzoom.waitFor({ state: "hidden" });
    await sheetsSettled(page);
    await paneSheet.getByRole("button", { name: "Cancel", exact: true }).tap();
    await paneSheet.waitFor({ state: "detached" });
    await selectPane(page, second);
    await currentPane(page, second);
    await frame(page, second).waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the canvas never overflows the phone sideways");
    tabSheet = await rowSheet(page, first);
    await tabSheet.getByRole("button", { name: "Rename tab", exact: true }).tap();
    const name = page.locator("input.agent-tab-rename");
    await name.waitFor();
    assert.equal(await name.count(), 1, "only the requested split pane row opens the tab name field");
    await page.keyboard.press("Escape");
    await name.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function checkTouchTablet(browser: Browser, origin: string, first: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await openApp(page, origin, first);
    const button = frame(page, first).locator(".pane-frame-menu");
    const size = await rect(button, "the tablet's pane menu");
    assert.ok(size.width >= 40 && size.height >= 40, "the tablet menu remains touch-sized above the mobile breakpoint");
    await button.tap();
    const menu = page.getByRole("menu", { name: /^Pane actions for / });
    await menu.waitFor();
    const tabletItems = await menu.getByRole("menuitem").allTextContents();
    assert.deepEqual(tabletItems.filter((item) => item !== "Clear pane name"),
      ["Rename pane", "Split right", "Split down", "Zoom pane", "Close pane"], "a wide touch canvas keeps split and zoom in its pane menu");
    await screenshot(page, "tablet-menu");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
  } finally { await context.close(); }
}

export async function checkTabMenu(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-menu-")));
  let workspaceId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-tab-menu" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    const second = (await paneSplit(first, "right", false)).pane_id;
    await paneRename(first, "canvas-first");
    await paneRename(second, "canvas-second");
    await checkDesktop(browser, origin, first, second, created.root_pane.tab_id);
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) await checkPhone(browser, origin, first, second, viewport);
    await checkTouchTablet(browser, origin, first);
    console.log("PASS sidebar inactive-tab close and touch reorder/rename menus, simultaneous split terminals, focus and input isolation, swap, split, divider drag, zoom and phone pane sheets");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-tab-menu-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try { await checkTabMenu(browser, `http://127.0.0.1:${server.port}`); }
  finally { await browser.close(); server.stop(); rmSync(state, { recursive: true, force: true }); }
}
