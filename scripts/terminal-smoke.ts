const cases = ["arrows", "backspace", "ctrl-enter", "pane-shortcuts"] as const;
const requested = process.argv.slice(2);
const selected = requested.length ? requested : cases;
for (const name of selected) {
  if (!(cases as readonly string[]).includes(name)) {
    console.error(`Unknown terminal smoke case: ${name}. Choose ${cases.join(", ")}.`);
    process.exit(2);
  }
}

let setupError: typeof import("./terminal-smoke-fixture.ts").SmokeSetupError | undefined;
try {
  const fixture = await import("./terminal-smoke-fixture.ts");
  const { withTerminalSmoke } = fixture;
  setupError = fixture.SmokeSetupError;
  const { checkCommandArrows } = await import("./terminal-command-arrows-regression.ts");
  const { checkCommandBackspace } = await import("./terminal-command-backspace-regression.ts");
  const { checkCtrlEnter } = await import("./terminal-ctrl-enter-regression.ts");
  const { checkPaneShortcuts } = await import("./terminal-pane-shortcut-regression.ts");
  await withTerminalSmoke(async ({ browser, origin, panes: [paneA, paneB] }) => {
    const checks = {
      arrows: () => checkCommandArrows(browser, origin, paneA),
      backspace: () => checkCommandBackspace(browser, origin, paneA),
      "ctrl-enter": () => checkCtrlEnter(browser, origin, paneA),
      "pane-shortcuts": () => checkPaneShortcuts(browser, origin, paneA, paneB),
    };
    for (const name of selected) {
      console.log(`SMOKE ${name}`);
      await checks[name as keyof typeof checks]();
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = setupError && error instanceof setupError ? 2 : 1;
}
