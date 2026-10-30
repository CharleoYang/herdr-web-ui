/**
 * Claude Code's rewind, read from the session and driven through its own dialog.
 *
 * Claude records a checkpoint per user message: a `file-history-snapshot` whose `messageId` is that
 * message's `uuid`, with the files it overwrote since. `/rewind` lists those points, newest last, and
 * restores a chosen one. The chat can offer the same list without guessing: the points come from the
 * session file, and the choice is carried out either in the live dialog (the agent is running) or by
 * the same edits made directly (the agent has ended).
 */

/** How a point is restored: through Claude's own dialog, or by editing the session and its files. */
export type RewindMode = "terminal" | "offline";

/** One message a conversation can be restored to "before you sent". */
export interface RewindPoint {
  /** The user message's uuid, which is also the checkpoint's `messageId`. */
  message_id: string;
  /** When the message was sent, ISO-8601. */
  at: string;
  /** The message's first line, cut to what the dialog's row shows. */
  prompt: string;
  /** Files this point restores: 0 leaves the code as it is ("No code restore"). */
  files: number;
}

export interface RewindList {
  mode: RewindMode;
  /** Oldest first: the order the dialog lists them in, so an index is a position in this array. */
  points: RewindPoint[];
  /** Why the list is empty, when it is. */
  reason?: "no_session" | "no_points";
}

/** What the chosen point restores. `both` needs the point to have files. */
export type RewindRestore = "conversation" | "code" | "both";

export interface RewindRequest {
  pane_id: string;
  message_id: string;
  restore?: RewindRestore;
}

export interface RewindResult {
  mode: RewindMode;
  point: RewindPoint;
  /** Files put back (offline mode), empty in terminal mode where Claude does it. */
  restored: string[];
  /** Where the session file was copied before it was cut (offline mode only). */
  backup: string | null;
}
