import type { RewindMode, RewindPoint, RewindRestore } from "../shared/rewind.ts";
import { rewindConfirmKeys, rewindMoves, rewindOptionIndex, rewindPanel, sameRewindText, type RewindPanel } from "./rewind.ts";

/** Why a rewind stopped before it changed anything. */
export type RewindRefusal =
  | "rewind_dialog_open"
  | "rewind_panel_missing"
  | "rewind_target_not_listed"
  | "rewind_target_mismatch"
  | "rewind_option_missing"
  | "rewind_confirm_missing";

export class RewindStopped extends Error {
  constructor(readonly reason: RewindRefusal, message: string) {
    super(message);
  }
}

/** What driving Claude's dialog needs from a pane; the route supplies herdr, tests supply a screen. */
export interface RewindDriver {
  /** The pane's `detection` text: what its agent detector and the dialog read. */
  read(): Promise<string>;
  type(text: string): Promise<void>;
  keys(keys: readonly string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const STEP_MS = 100;
const PANEL_DEADLINE_MS = 4000;

/**
 * Carries a chosen point through Claude Code's own `/rewind`, in its two screens: the message list,
 * then the confirm screen of that message.
 *
 * Every step is verified against the screen before the next keystroke: the chosen row's own text
 * must be the message's, and the confirm screen must name that same message. Anything else — the
 * dialog did not open, the list does not hold it, the highlight landed elsewhere — is undone with
 * Escape and refused, so a wrong rewind is never confirmed.
 */
export async function driveRewind(
  driver: RewindDriver,
  point: RewindPoint,
  restore: RewindRestore,
): Promise<{ keys: string[] }> {
  // a dialog already open is the user's: it is never re-driven, and Escape here would discard theirs
  const before = rewindPanel(await driver.read());
  if (before !== null) {
    throw new RewindStopped("rewind_dialog_open", "Claude Code's rewind dialog is already open in this pane");
  }

  const sent: string[] = [];
  const send = async (keys: readonly string[]): Promise<void> => {
    sent.push(...keys);
    await driver.keys(keys);
  };
  const escape = async (): Promise<void> => {
    await send(["esc"]);
  };

  await driver.type("/rewind");
  await send(["enter"]);

  const list = await waitForPanel(driver, "select");
  if (list?.kind !== "select") {
    await escape();
    throw new RewindStopped("rewind_panel_missing", "Claude Code's rewind list did not open");
  }
  const target = list.rows.findIndex((row) => sameRewindText(row.text, point.prompt));
  if (target < 0) {
    await escape();
    throw new RewindStopped("rewind_target_not_listed", `the rewind list does not show "${point.prompt}"`);
  }
  if (target !== list.highlighted) {
    // the moves go first and the screen is read again: Enter is only pressed once the highlight is
    // seen on the message, so a list that scrolled differently cannot be confirmed by accident
    await send(rewindMoves(list.highlighted, target));
    const moved = rewindPanel(await driver.read());
    if (moved?.kind !== "select" || moved.highlighted !== target || !sameRewindText(moved.rows[target]?.text ?? "", point.prompt)) {
      await escape();
      throw new RewindStopped("rewind_target_mismatch", "the rewind list's highlight did not land on the message");
    }
  }
  await send(["enter"]);

  const confirm = await waitForPanel(driver, "confirm");
  if (confirm?.kind !== "confirm") {
    await escape();
    throw new RewindStopped("rewind_confirm_missing", "Claude Code's rewind did not ask to confirm");
  }
  if (confirm.target !== null && !sameRewindText(confirm.target, point.prompt)) {
    await escape();
    throw new RewindStopped("rewind_target_mismatch", "the confirm screen names another message");
  }
  const option = rewindOptionIndex(confirm.options, restore);
  if (option === null) {
    await escape();
    throw new RewindStopped("rewind_option_missing", `Claude Code offers no "${restore}" choice for this message`);
  }
  await send(rewindConfirmKeys(confirm.highlighted, option));

  // the panel leaving the screen is what says Claude took it: anything else is reported, not assumed
  for (let step = 0; step < PANEL_DEADLINE_MS / STEP_MS; step += 1) {
    if (rewindPanel(await driver.read()) === null) return { keys: sent };
    await driver.sleep(STEP_MS);
  }
  throw new RewindStopped("rewind_confirm_missing", "the rewind dialog is still on screen after the choice");
}

async function waitForPanel(driver: RewindDriver, kind: "select" | "confirm"): Promise<RewindPanel> {
  for (let step = 0; step < PANEL_DEADLINE_MS / STEP_MS; step += 1) {
    const panel = rewindPanel(await driver.read());
    if (panel !== null && panel.kind === kind) return panel;
    await driver.sleep(STEP_MS);
  }
  return null;
}

/** The list a pane can offer, and how it would be carried out. */
export function rewindMode(live: boolean): RewindMode {
  return live ? "terminal" : "offline";
}
