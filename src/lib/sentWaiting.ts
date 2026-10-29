import type { ConversationTurn } from "../../shared/protocol.ts";

/**
 * The turns the chat held when a message was sent. Its own turn is written after the send, so it
 * is none of these; and a transcript's times come from the PC's clock, the browser's never enter.
 */
export interface WaitingBaseline {
  keys: ReadonlySet<string>;
  /** the newest time among them, in the transcript's (the PC's) clock */
  latest: number | null;
}

/** One confirmed send, independent of any other sends to the same pane. */
export interface WaitingSend {
  id: number;
  pane: string;
  text: string;
  /** Captured before submitting, not when the receipt eventually arrives (the browser's clock). */
  at: number;
  /** what the chat held at send time; null when it had shown no turns, and `at` is the only guard */
  after: WaitingBaseline | null;
}

type Turn = Pick<ConversationTurn, "role" | "parts" | "ts">;
type SentText = Pick<WaitingSend, "text" | "at"> & { after?: WaitingBaseline | null };

/**
 * Only what the terminal is known to do to a sent message: CRLF line ends, a space closing a final
 * @mention (server/core/composer.ts closeMention), whitespace at the ends of lines and around it.
 * Spaces inside a line stay: "change a b" and "change ab" are two messages.
 */
const said = (text: string): string => text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();

/** A command (`/cost`, a skill, `!` bash mode) comes back as a command, never as this user turn. */
const becomesTurn = (text: string): boolean => !/^\s*[/!]/u.test(text);

function newerThanSend(send: SentText, turn: Turn, key: string | null): boolean {
  const at = turn.ts === null ? Number.NaN : Date.parse(turn.ts);
  if (!Number.isFinite(at)) return false;
  const after = send.after ?? null;
  if (after === null) return at >= send.at;
  return !(key !== null && after.keys.has(key)) && (after.latest === null || at >= after.latest);
}

function turnMatches(send: SentText, turn: Turn, key: string | null = null): boolean {
  if (turn.role !== "user" || !newerThanSend(send, turn, key)) return false;
  return said(turn.parts.filter((part) => part.kind === "text").map((part) => part.text).join(" ")) === said(send.text);
}

/** Older turns and other messages cannot stand in for this send's own turn. */
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
/** the turns each pane's chat showed last, for the baseline of its next send */
const shown = new Map<string, WaitingBaseline>();
const empty: readonly WaitingSend[] = [];
const listeners = new Set<() => void>();
const announce = (): void => { for (const listener of listeners) listener(); };
let nextId = 0;

/** Two PCs may reuse a pane id. */
export const waitingKey = (machineId: string, paneId: string): string => `${machineId}:${paneId}`;

/** Each turn's identity, the same turn twice told apart by its place. */
function keyed(turns: readonly Turn[]): { turn: Turn; key: string }[] {
  const occurrences = new Map<string, number>();
  return turns.map((turn) => {
    const identity = JSON.stringify([turn.ts, turn.role, turn.parts]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { turn, key: `${identity}:${occurrence}` };
  });
}

/** What the pane's chat holds now; take it before submitting, as `at` is. */
export function waitingBaseline(key: string): WaitingBaseline | null {
  return shown.get(key) ?? null;
}

export function rememberWaitingSend(key: string, text: string, at = Date.now(), after: WaitingBaseline | null = null): void {
  if (text.trim() === "" || !becomesTurn(text)) return;
  const pane = waiting.get(key) ?? { sends: empty, claimed: new Set<string>() };
  pane.sends = [...pane.sends, { id: ++nextId, pane: key, text, at, after }].sort((a, b) => a.id - b.id);
  waiting.set(key, pane);
  announce();
}

/** Stable snapshots for useSyncExternalStore, retained while another pane is active. */
export function currentWaitingSends(key: string): readonly WaitingSend[] {
  return waiting.get(key)?.sends ?? empty;
}

/** Consume each transcript turn once, leaving every other send visible until its own turn exists. */
export function settleWaitingSends(key: string, turns: readonly Turn[]): void {
  const candidates = keyed(turns);
  if (candidates.length > 0) {
    const times = turns.map((turn) => turn.ts === null ? Number.NaN : Date.parse(turn.ts)).filter(Number.isFinite);
    shown.set(key, { keys: new Set(candidates.map((candidate) => candidate.key)), latest: times.length > 0 ? Math.max(...times) : null });
  }
  const pane = waiting.get(key);
  if (!pane || pane.sends.length === 0) return;
  const remaining = pane.sends.filter((send) => {
    const match = candidates.find((candidate) => !pane.claimed.has(candidate.key) && turnMatches(send, candidate.turn, candidate.key));
    if (!match) return true;
    pane.claimed.add(match.key);
    return false;
  });
  if (remaining.length === pane.sends.length) return;
  pane.sends = remaining;
  announce();
}

/** A removed pane releases its waiting sends, consumed-turn identities and shown turns. */
export function forgetWaitingSends(key: string): void {
  shown.delete(key);
  if (waiting.delete(key)) announce();
}

export function subscribeWaitingSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
