import type { ConversationTurn } from "../../shared/protocol.ts";

/** One confirmed send, independent of any other sends to the same pane. */
export interface WaitingSend {
  id: number;
  pane: string;
  text: string;
  /** Captured before submitting, not when the receipt eventually arrives. */
  at: number;
}

type Turn = Pick<ConversationTurn, "role" | "parts" | "ts">;
type SentText = Pick<WaitingSend, "text" | "at">;
const said = (text: string): string => text.replace(/\s+/gu, "");

function turnMatches(send: SentText, turn: Turn): boolean {
  if (turn.role !== "user" || turn.ts === null || Date.parse(turn.ts) < send.at || !Number.isFinite(Date.parse(turn.ts))) return false;
  const wanted = said(send.text);
  const spoken = said(turn.parts.filter((part) => part.kind === "text").map((part) => part.text).join(" "));
  if (spoken === wanted) return true;
  // Only an explicit ellipsis identifies a shortened copy; an unmarked shared opening is not
  // evidence. The shortened prefix must itself be substantial, never a short reply such as yes.
  const shortened = spoken.replace(/(?:…|\.{3})$/u, "");
  return shortened !== spoken && shortened.length >= 20 && wanted.startsWith(shortened);
}

/** Older turns and unrelated shared prefixes cannot stand in for this send's own turn. */
export function transcriptHolds(send: SentText, turns: readonly Turn[]): boolean {
  return said(send.text) === "" || turns.some((turn) => turnMatches(send, turn));
}

export function waitingText(send: SentText | null, turns: readonly Turn[]): string | null {
  return send === null || transcriptHolds(send, turns) ? null : send.text;
}

interface WaitingPane {
  sends: readonly WaitingSend[];
  /** A turn can acknowledge only one send, including across refreshes and tab unmounts. */
  claimed: Set<string>;
}
const waiting = new Map<string, WaitingPane>();
const empty: readonly WaitingSend[] = [];
const listeners = new Set<() => void>();
const announce = (): void => { for (const listener of listeners) listener(); };
let nextId = 0;

/** Two PCs may reuse a pane id. */
export const waitingKey = (machineId: string, paneId: string): string => `${machineId}:${paneId}`;

export function rememberWaitingSend(key: string, text: string, at = Date.now()): void {
  if (text.trim() === "") return;
  const pane = waiting.get(key) ?? { sends: empty, claimed: new Set<string>() };
  pane.sends = [...pane.sends, { id: ++nextId, pane: key, text, at }].sort((a, b) => a.at - b.at || a.id - b.id);
  waiting.set(key, pane);
  announce();
}

/** Stable snapshots for useSyncExternalStore, retained while another pane is active. */
export function currentWaitingSends(key: string): readonly WaitingSend[] {
  return waiting.get(key)?.sends ?? empty;
}

/** Consume each transcript turn once, leaving every other send visible until its own turn exists. */
export function settleWaitingSends(key: string, turns: readonly Turn[]): void {
  const pane = waiting.get(key);
  if (!pane || pane.sends.length === 0) return;
  const occurrences = new Map<string, number>();
  const candidates = turns.map((turn) => {
    const identity = JSON.stringify([turn.ts, turn.role, turn.parts]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { turn, key: `${identity}:${occurrence}` };
  });
  const remaining = pane.sends.filter((send) => {
    const match = candidates.find((candidate) => !pane.claimed.has(candidate.key) && turnMatches(send, candidate.turn));
    if (!match) return true;
    pane.claimed.add(match.key);
    return false;
  });
  if (remaining.length === pane.sends.length) return;
  pane.sends = remaining;
  announce();
}

/** A removed pane releases both its waiting sends and consumed-turn identities. */
export function forgetWaitingSends(key: string): void {
  if (waiting.delete(key)) announce();
}

export function subscribeWaitingSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
