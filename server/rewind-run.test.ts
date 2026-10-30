import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import type { RewindPoint } from "../shared/rewind.ts";
import { driveRewind, RewindStopped, type RewindDriver } from "./rewind-run.ts";

const screen = (state: string, width = 40): string =>
  readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

const APPLE: RewindPoint = { message_id: "apple-id", at: "2026-10-20T10:00:00.000Z", prompt: "apple", files: 0 };
const BANANA: RewindPoint = { message_id: "banana-id", at: "2026-10-20T10:00:10.000Z", prompt: "banana", files: 0 };
const CHERRY: RewindPoint = { message_id: "cherry-id", at: "2026-10-20T10:03:00.000Z", prompt: "cherry", files: 0 };

/** The rows the recorded list shows, in its own order. */
const ROWS = ["apple", "banana"];

/** The recorded list with its `❯` moved to `highlight`: everything else stays as it was recorded. */
function markRow(recorded: string, highlight: number): string {
  const lines = recorded.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    const row = ROWS.findIndex((candidate) => trimmed === candidate || trimmed === `❯ ${candidate}`);
    if (row < 0) continue;
    const indent = line.slice(0, line.indexOf(trimmed));
    lines[index] = row === highlight ? `${indent}❯ ${ROWS[row]}` : `${indent}${ROWS[row]}`;
  }
  return lines.join("\n");
}

/** A pane whose screen answers the driver: the list moves, Enter advances, the panel closes. */
class Fake {
  stage: "closed" | "list" | "confirm" = "closed";
  // the list opens on its newest message, as Claude draws it
  highlight = 1;
  readonly typed: string[] = [];
  readonly sent: string[] = [];
  constructor(private readonly options: { moves?: boolean; confirm?: string } = {}) {}
  driver(): RewindDriver {
    return {
      read: async () => this.read(),
      type: async (text) => {
        this.typed.push(text);
      },
      keys: async (keys) => {
        for (const key of keys) this.press(key);
        this.sent.push(...keys);
      },
      sleep: async () => {},
    };
  }
  read(): string {
    if (this.stage === "closed") return screen("closed");
    if (this.stage === "list") return markRow(screen("select-banana"), this.highlight);
    // the recorded confirm screen, naming the message this pane's list actually took
    const base = screen(this.options.confirm ?? "confirm-apple-restore", 120);
    const row = ROWS[this.picked] ?? ROWS[0]!;
    return base.replace(/^(\s*│\s+).*$/mu, `$1${row}`);
  }
  private picked = 0;
  private press(key: string): void {
    if (key === "up" || key === "down") {
      if (this.options.moves === false) return;
      const next = key === "up" ? this.highlight - 1 : this.highlight + 1;
      this.highlight = Math.max(0, Math.min(ROWS.length - 1, next));
      return;
    }
    if (key !== "enter") return;
    if (this.stage === "closed") this.stage = "list";
    else if (this.stage === "list") {
      this.picked = this.highlight;
      this.stage = "confirm";
    } else this.stage = "closed";
  }
}

describe("driving Claude's rewind dialog", () => {
  it("opens the list, moves to the message, confirms it, and waits for the dialog to close", async () => {
    const pane = new Fake();
    const outcome = await driveRewind(pane.driver(), APPLE, "conversation");
    expect(pane.typed).toEqual(["/rewind"]);
    // enter opens the list, up lands on apple, enter takes it, enter takes "Restore conversation"
    expect(pane.sent).toEqual(["enter", "up", "enter", "enter"]);
    expect(outcome.keys).toEqual(pane.sent);
    expect(pane.stage).toBe("closed");
  });

  it("takes a message that is already highlighted without moving at all", async () => {
    const pane = new Fake();
    const outcome = await driveRewind(pane.driver(), BANANA, "conversation");
    expect(pane.sent).toEqual(["enter", "enter", "enter"]);
    expect(outcome.keys).toEqual(pane.sent);
  });

  it("does nothing when a dialog is already open: it is the user's own", async () => {
    const pane = new Fake();
    pane.stage = "list";
    await expect(driveRewind(pane.driver(), APPLE, "conversation")).rejects.toBeInstanceOf(RewindStopped);
    expect(pane.typed).toEqual([]);
    expect(pane.sent).toEqual([]);
  });

  it("refuses a message the list does not show, and closes the list", async () => {
    const pane = new Fake();
    const error = await driveRewind(pane.driver(), CHERRY, "conversation").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RewindStopped);
    expect((error as RewindStopped).reason).toBe("rewind_target_not_listed");
    expect(pane.sent).toEqual(["enter", "esc"]);
  });

  it("refuses before Enter when the highlight did not land on the message", async () => {
    // a list that does not scroll under the keys: the move goes nowhere
    const pane = new Fake({ moves: false });
    const error = await driveRewind(pane.driver(), APPLE, "conversation").catch((cause: unknown) => cause);
    expect((error as RewindStopped).reason).toBe("rewind_target_mismatch");
    // the message was never taken: no Enter after the failed move
    expect(pane.sent).toEqual(["enter", "up", "esc"]);
    expect(pane.stage).toBe("list");
  });

  it("refuses a confirm screen that offers no such choice, and closes it", async () => {
    // the recorded confirm screen offers "Restore conversation", not code alone
    const pane = new Fake({ confirm: "confirm-apple-restore" });
    const error = await driveRewind(pane.driver(), APPLE, "code").catch((cause: unknown) => cause);
    expect((error as RewindStopped).reason).toBe("rewind_option_missing");
    // enter opens the list, up lands on apple, enter takes it, and Escape leaves the confirm screen
    expect(pane.sent).toEqual(["enter", "up", "enter", "esc"]);
    expect(pane.stage).toBe("confirm");
  });

  it("refuses when the list never opens", async () => {
    const pane = new Fake();
    // Enter does not open it (an agent that ignores the command)
    const stuck = { ...pane.driver(), keys: async (keys: readonly string[]) => void pane.sent.push(...keys) };
    const error = await driveRewind(stuck, BANANA, "conversation").catch((cause: unknown) => cause);
    expect((error as RewindStopped).reason).toBe("rewind_panel_missing");
    expect(pane.sent).toEqual(["enter", "esc"]);
  });
});
