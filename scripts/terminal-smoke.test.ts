import { expect, test } from "bun:test";
import { join } from "node:path";

test("unknown terminal smoke cases fail before starting a live fixture", () => {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "terminal-smoke.ts"), "not-a-case"], {
    env: { ...process.env, HERDR_TEST_LIVE: "1", HERDR_TEST_MODE: "unit" },
    timeout: 5_000,
  });
  expect(child.exitCode).toBe(2);
});

test("a valid terminal smoke case refuses a live or unisolated environment", () => {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "terminal-smoke.ts"), "pane-shortcuts"], {
    env: { ...process.env, HERDR_TEST_LIVE: "1", HERDR_TEST_MODE: "unit" },
    timeout: 5_000,
  });
  expect(child.exitCode).toBe(2);
});
