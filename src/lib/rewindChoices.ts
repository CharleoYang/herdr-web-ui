import type { RewindMode, RewindPoint, RewindRestore } from "../../shared/rewind.ts";

/** One thing the chat can offer for a checkpoint: what it restores, and how it is labelled. */
export interface RewindChoice {
  restore: RewindRestore;
  /** A dictionary key, so every locale says it in its own words. */
  label: "Restore conversation" | "Restore code and conversation" | "Restore code";
  /** Whether this choice is the one to offer first. */
  primary: boolean;
}

/**
 * What to offer for a checkpoint.
 *
 * `code` alone is offered only when a live agent's own dialog is the one restoring (its own wording
 * decides what it can do): a direct restore has no reason to put files back without the conversation
 * that goes with them.
 */
export function rewindChoices(point: RewindPoint, mode: RewindMode): RewindChoice[] {
  if (point.files === 0) return [{ restore: "conversation", label: "Restore conversation", primary: true }];
  if (mode === "terminal") {
    return [
      { restore: "both", label: "Restore code and conversation", primary: true },
      { restore: "conversation", label: "Restore conversation", primary: false },
      { restore: "code", label: "Restore code", primary: false },
    ];
  }
  return [
    { restore: "both", label: "Restore code and conversation", primary: true },
    { restore: "conversation", label: "Restore conversation", primary: false },
  ];
}

/** Why a rewind was refused, in words a person can act on. */
export function rewindErrorText(code: string): string {
  switch (code) {
    case "rewind_dialog_open":
      return "Claude Code's rewind dialog is already open in this pane; finish or close it first";
    case "rewind_panel_missing":
      return "Claude Code did not open its rewind list";
    case "rewind_target_not_listed":
      return "That message is not in Claude Code's rewind list";
    case "rewind_target_mismatch":
      return "Claude Code's rewind list did not land on that message; nothing was restored";
    case "rewind_option_missing":
      return "Claude Code offers no such choice for that message";
    case "rewind_confirm_missing":
      return "Claude Code's rewind did not confirm; nothing was restored";
    case "rewind_session_missing":
      return "This pane's Claude session cannot be read";
    case "rewind_point_unknown":
      return "The session no longer holds that message";
    case "rewind_no_code":
      return "That message changed no file to put back";
    default:
      return "The rewind did not go through";
  }
}

/** A checkpoint's time as the chat shows it: the clock for today, the date for anything older. */
export function rewindWhen(at: string, now = Date.now()): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
