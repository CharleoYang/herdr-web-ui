import type { ConversationTurn } from "../../shared/protocol.ts";

/** A message this browser sent that the pane has not turned into a transcript row yet. */
export interface WaitingSend {
  pane: string;
  text: string;
  /** when it left the box: a row older than this is not the one it became */
  at: number;
}

// a pane keeps what was typed; wrapping, reflowing and a trimmed tail change only the spaces
const said = (text: string): string => text.replace(/\s+/gu, "");

/**
 * Whether the transcript already holds the message this browser sent: Claude records it as a user
 * turn only when its next turn starts, so until then the chat would show nothing at all, and the
 * reader cannot tell a sent message from a lost one.
 */
export function transcriptHolds(send: { text: string }, turns: readonly Pick<ConversationTurn, "role" | "parts">[]): boolean {
  const wanted = said(send.text);
  if (wanted === "") return true;
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const spoken = said(turn.parts.filter((part) => part.kind === "text").map((part) => (part as { text: string }).text).join(" "));
    // the pane keeps what was typed: a wrapping or a trimmed tail is the same message
    if (spoken === wanted) return true;
    // a prefix only counts when it is long enough to be this message rather than a shared opening
    if (spoken.length >= 20 && (spoken.startsWith(wanted) || wanted.startsWith(spoken))) return true;
  }
  return false;
}

/** The text still waiting for a turn of its own, or null once the transcript has it. */
export function waitingText(send: WaitingSend | null, turns: readonly Pick<ConversationTurn, "role" | "parts">[]): string | null {
  if (send === null || said(send.text) === "") return null;
  return transcriptHolds(send, turns) ? null : send.text;
}

/**
 * The waiting messages, per pane, kept here and not in a component: switching tabs unmounts the
 * chat, and a message that vanishes with it is the very doubt this answers (the reader goes to
 * another tab while the agent finishes its turn, and comes back to a queue they cannot see).
 * A pane's entry leaves when its transcript has the message, or when the pane is gone.
 */
const waiting = new Map<string, WaitingSend>();
const listeners = new Set<() => void>();
const announce = (): void => { for (const listener of listeners) listener(); };

/** the key a pane's waiting message is kept under: two PCs may reuse a pane id */
export const waitingKey = (machineId: string, paneId: string): string => `${machineId}:${paneId}`;

export function rememberWaitingSend(key: string, text: string, at = Date.now()): void {
  if (text.trim() === "") return;
  waiting.set(key, { pane: key, text, at });
  announce();
}

export function forgetWaitingSend(key: string): void {
  if (waiting.delete(key)) announce();
}

export function currentWaitingSend(key: string): WaitingSend | null {
  return waiting.get(key) ?? null;
}

export function subscribeWaitingSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
