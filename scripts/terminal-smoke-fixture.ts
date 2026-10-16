import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { disposableConfig } from "./disposable-config.ts";
import { chromePath } from "./chrome-path.ts";

export class SmokeSetupError extends Error {}

export interface TerminalSmokeFixture {
  browser: Browser;
  origin: string;
  panes: readonly [string, string];
}

/** `check run` owns isolation/daemon cleanup; this fixture owns its bridge, browser and panes. */
export async function withTerminalSmoke<T>(run: (fixture: TerminalSmokeFixture) => Promise<T>): Promise<T> {
  const session = process.env.HERDR_TEST_SESSION;
  const socket = join(process.env.XDG_CONFIG_HOME ?? "", "herdr", "sessions", session ?? "", "herdr.sock");
  if (process.env.HERDR_TEST_LIVE === "1" || process.env.HERDR_TEST_MODE === "unit"
    || !session || !disposableConfig(process.env, socket)) {
    throw new SmokeSetupError("Terminal smoke requires disposable isolation; use bun run smoke:terminal (or bun run check run).");
  }
  if (!Bun.which(process.env.HERDR_WEB_HERDR_BIN || "herdr") || !Bun.which("node")) {
    throw new Error("Terminal smoke requires herdr and Node on PATH (HERDR_WEB_HERDR_BIN may select herdr).");
  }
  if (!existsSync(new URL("../dist/index.html", import.meta.url))) {
    throw new Error("Build the web UI first, or use bun run smoke:terminal to build and run it.");
  }
  // This module starts herdr on import: never load it before the disposable-environment guard.
  await import("./test-herdr.ts");
  if (process.env.HERDR_SOCKET !== socket) throw new Error("The fixture did not attach to its isolated herdr socket.");

  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-terminal-smoke-")));
  const workspaces: string[] = [];
  let browser: Browser | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const panes: string[] = [];
    for (const suffix of ["a", "b"]) {
      const created = await workspaceCreate({ cwd: root, label: `terminal-smoke-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
    return await run({ browser, origin: `http://127.0.0.1:${server.port}`, panes: [panes[0]!, panes[1]!] });
  } finally {
    try { await browser?.close(); }
    finally {
      try { server?.stop(); }
      finally {
        try { await Promise.all(workspaces.map((id) => workspaceClose(id))); }
        finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }
}
