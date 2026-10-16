import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { withTerminalSmoke, SmokeSetupError } from "./terminal-smoke-fixture.ts";
import { createPendingInputCheck } from "./pending-input-regression.ts";
import { workspaceClose } from "../server/herdr/client.ts";

const evidence = process.env.CHECK_BROWSER_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

try {
  await withTerminalSmoke(async ({ browser, origin }) => {
    const workspaces: string[] = [];
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let releasePending: (() => void) | undefined;
    let failed = false;
    let primaryError: unknown;
    const secondaryErrors: Array<{ stage: string; error: unknown }> = [];
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pending-input-smoke-")));
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
      page = await context.newPage();
      const pending = createPendingInputCheck(page, evidence);
      releasePending = () => pending.release();
      await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
        const upstream = socket.connectToServer();
        upstream.onMessage((raw) => {
          if (!pending.forwardSnapshot(socket, raw)) socket.send(raw);
        });
      });
      await page.goto(origin);
      await page.locator(".conn-live").waitFor();
      await pending.run(root, workspaces);
    } catch (error) {
      failed = true;
      primaryError = error;
    } finally {
      try {
        releasePending?.();
        if (evidence) {
          if (existsSync(join(root, "pending-input.jsonl"))) {
            copyFileSync(join(root, "pending-input.jsonl"), join(evidence, "focused-pty.jsonl"));
          }
          if (page) {
            writeFileSync(join(evidence, "focused-dom.html"), await page.content());
            await page.screenshot({ path: join(evidence, "focused.png") });
          }
        }
      } catch (error) {
        secondaryErrors.push({ stage: "diagnostics", error });
      }
      try {
        await context?.close();
      } catch (error) {
        secondaryErrors.push({ stage: "context cleanup", error });
      }
      const closed = await Promise.allSettled(workspaces.map((id) => workspaceClose(id)));
      for (const result of closed) {
        if (result.status === "rejected") secondaryErrors.push({ stage: "workspace cleanup", error: result.reason });
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        secondaryErrors.push({ stage: "root cleanup", error });
      }
    }
    for (const { stage, error } of secondaryErrors) {
      console.error(`Pending-input smoke ${stage} failed:`, error);
    }
    if (failed) throw primaryError;
    if (secondaryErrors.length) throw secondaryErrors[0]!.error;
  });
} catch (error) {
  console.error(error);
  process.exitCode = error instanceof SmokeSetupError ? 2 : 1;
}
