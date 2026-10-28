import { sameMessage } from "./compose.ts";

/**
 * What a send whose receipt never came can still learn: the pane's own input box.
 *
 * Claude (and omp) hold a message typed while a turn runs until that turn ends, and herdr may
 * answer late enough that the bridge gives up on the receipt. The box is then the one oracle that
 * is local and cheap: a box that no longer holds what was typed means the words left it — queued
 * for the next turn, which is delivered — while a box that still holds them means nothing left, and
 * the reader must decide. `null` (unreadable, or an older server) decides nothing.
 */
export function sendLeftTheBox(sent: string, draft: string | null): boolean {
  // nothing read (an older server, a clipped box, a failed read): the app decides nothing
  if (draft === null) return false;
  // an empty box — the caret alone is still an empty box (Claude draws `❯`, omp its own): the
  // words left it
  if (draft.replace(/[\s❯>›│]/gu, "") === "") return true;
  // the words are still there: nothing left, and the reader decides when to try again
  if (sameMessage(draft, sent)) return false;
  // something else is in the box: ours may have been replaced rather than sent, so this is no proof
  return false;
}

/**
 * Whether a refusal leaves the delivery unknown, so the pane's box can decide it. Two shapes:
 * - `submit_partial`: the draft was cleared without an Enter receipt;
 * - a herdr connection that closed under a write (`closed`, `socket_error`): herdr may have typed
 *   the words before it went, and only the box can say. Its message names the call it lost.
 * A refusal from anything else (a read, a queue check, an agent that refused the prompt outright)
 * stays a refusal.
 */
export function uncertainSend(code: string, message: string): boolean {
  if (code === "submit_partial") return true;
  if (code !== "closed" && code !== "socket_error") return false;
  return /answering (?:agent\.prompt|pane\.send_text|pane\.send_keys)\b/u.test(message);
}
