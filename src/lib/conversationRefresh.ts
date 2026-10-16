import type { ConversationResponse, ServerMessage } from "../../shared/protocol.ts";

export type ConversationDeltaMessage = Extract<ServerMessage, { type: "conversation-delta" }>;
export type ConversationUpdate = ConversationDeltaMessage | "disconnect" | "reconnect";

const MAX_DELTA_BYTES = 262_144;
const encoder = new TextEncoder();
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";
const nullableNumber = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value));

function validSkill(value: unknown): boolean {
  return record(value) && typeof value.name === "string" && (value.evidence === "invocation" || value.evidence === "instructions")
    && (value.status === "requested" || value.status === "loaded" || value.status === "failed") && optionalString(value.path);
}

function validImage(value: unknown): boolean {
  return record(value) && typeof value.media_type === "string" && typeof value.ref === "string";
}

function validPart(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.kind) {
    case "text": return typeof value.text === "string" && (value.phase === undefined || value.phase === "commentary" || value.phase === "final_answer");
    case "thinking": case "compact": return typeof value.text === "string";
    case "notice": return typeof value.text === "string" && optionalString(value.source);
    case "image": return validImage(value);
    case "skill": return validSkill(value.skill);
    case "tool": return [value.name, value.summary, value.input, value.output].every((field) => typeof field === "string")
      && optionalBoolean(value.error) && (value.arguments_omitted === undefined || value.arguments_omitted === true)
      && (value.skill === undefined || validSkill(value.skill)) && optionalString(value.output_ref)
      && (value.output_size === undefined || (typeof value.output_size === "number" && Number.isFinite(value.output_size)))
      && (value.images === undefined || (Array.isArray(value.images) && value.images.every(validImage)));
    case "task_result": return Array.isArray(value.tasks) && value.tasks.every((task: unknown) => record(task)
      && typeof task.id === "string" && typeof task.title === "string"
      && (task.agent === null || typeof task.agent === "string") && (task.model === null || typeof task.model === "string")
      && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
      && [task.duration_ms, task.turns, task.tool_calls, task.tokens].every(nullableNumber)
      && typeof task.result === "string" && optionalBoolean(task.result_cut));
    default: return false;
  }
}

/** Structural safety only: opaque signatures cannot prove the reader included every turn. */
function validDelta(message: ConversationDeltaMessage): boolean {
  const delta = message.delta;
  return typeof message.signature === "string" && record(delta)
    && (delta.base_signature === null || typeof delta.base_signature === "string")
    && optionalString(delta.history_id) && (delta.cursor === undefined || delta.cursor === null || typeof delta.cursor === "string")
    && Array.isArray(delta.turns) && delta.turns.every((turn: unknown) => record(turn)
      && (turn.role === "user" || turn.role === "assistant") && (turn.ts === null || typeof turn.ts === "string")
      && optionalString(turn.end_ts) && Array.isArray(turn.parts) && turn.parts.every(validPart))
    && encoder.encode(JSON.stringify(message)).byteLength <= MAX_DELTA_BYTES;
}

/** With pushes, a lost one still gets a full conversation read. */
const BACKSTOP_MS = 10_000;

/** REST invalidations never start newest-page reads faster than the former 2s polling cadence,
 * and a chat without complete-page pushes reads at that cadence. */
const INVALIDATION_MS = 2000;

/** One serial lane for newest pages and their gap fills; an older page starts in it, after the
 * newest read before it, but never holds the next newest read back. */
export class ConversationRefresh {
  private read: ((isCurrent: () => boolean) => Promise<void>) | null = null;
  private pending = false;
  private invalidated = false;
  private running = false;
  private timer: number | undefined;
  private newestAt = -Infinity;
  private pushes = false;
  private readonly pages: (() => Promise<void>)[] = [];
  private generation = 0;
  private deltaSignature: string | null = null;

  /** A dropped connection must fence its REST callbacks even before React renders the edge. */
  resetConnection(): void {
    this.generation += 1;
    this.deltaSignature = null;
  }

  /** Replace only the newest page; loaded history is owned by the REST pagination lane. */
  replacePage(message: ConversationDeltaMessage, paneId: string, current: ConversationResponse | null, hasHistory: boolean): ConversationResponse | null {
    if (message.pane_id !== paneId || this.read === null || this.running || this.pending) return null;
    if (!validDelta(message) || current === null || message.delta.source !== current.source
      || message.delta.history_id !== current.history_id
      || (hasHistory && (message.delta.cursor ?? null) !== (current.cursor ?? null))) {
      this.deltaSignature = null;
      this.invalidate();
      return null;
    }
    if (message.signature === this.deltaSignature) return null;
    if (this.deltaSignature !== null && message.delta.base_signature !== null && message.delta.base_signature !== this.deltaSignature) {
      this.deltaSignature = null;
      this.invalidate();
      return null;
    }
    this.deltaSignature = message.signature;
    // Optional page fields describe THIS page; never inherit a missing history ID or cursor.
    return { ...current, source: message.delta.source, history_id: message.delta.history_id, cursor: message.delta.cursor ?? null, turns: message.delta.turns };
  }

  /** Replace a cancelled reader without letting its still-pending REST request overlap this one. */
  setRead(read: (isCurrent: () => boolean) => Promise<void>): void {
    this.resetConnection();
    this.clearTimer();
    this.pending = false;
    this.invalidated = false;
    this.newestAt = -Infinity;
    this.read = read;
  }

  /** Whether the bridge pushes this pane's transcript changes; without, the backstop is the poll. */
  setPushes(available: boolean): void {
    if (this.pushes === available) return;
    this.pushes = available;
    // a waiting backstop takes the new cadence; a read in flight schedules it when it ends
    if (this.read !== null && !this.running && !this.invalidated && this.timer !== undefined) {
      this.clearTimer();
      this.timer = window.setTimeout(() => this.refresh(), this.backstop());
    }
  }

  /** A newest-page read is in flight: one requested now would start only after it settles. */
  get reading(): boolean {
    return this.running;
  }

  refresh(): void {
    if (this.read === null) return;
    this.clearTimer();
    this.pending = true;
    this.invalidated = false;
    void this.drain();
  }

  /** The first push after idle reads immediately; further pushes share a fixed trailing deadline. */
  invalidate(): void {
    if (this.read === null || this.invalidated) return;
    this.invalidated = true;
    this.clearTimer();
    void this.drain();
  }

  /** An explicitly requested older page starts once the newest read in flight (and its gap fill)
   * has settled, so a history change found there drops it first. A slow older page never delays
   * the newest page: a clear or a new turn still shows while it loads, and its caller discards it. */
  page<T>(read: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pages.push(async () => {
      try { resolve(await read()); }
      catch (cause) { reject(cause); }
    });
    this.clearTimer();
    void this.drain();
    return promise;
  }

  /** Hidden/unmounted readers leave no timer or pending refresh; an in-flight read finishes first. */
  stop(): void {
    this.resetConnection();
    this.read = null;
    this.pending = false;
    this.invalidated = false;
    this.clearTimer();
  }

  private backstop(): number {
    return this.pushes ? BACKSTOP_MS : INVALIDATION_MS;
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const page = this.pages.shift();
        if (page !== undefined) {
          void page();
          continue;
        }
        if (this.read === null || (!this.pending && !this.invalidated)) break;
        if (!this.pending && performance.now() < this.newestAt + INVALIDATION_MS) break;
        this.pending = false;
        this.invalidated = false;
        // Monotonic elapsed time keeps wall-clock corrections out of the rate bound.
        this.newestAt = performance.now();
        this.deltaSignature = null;
        const read = this.read;
        const generation = this.generation;
        await read(() => this.read === read && this.generation === generation);
      }
    } finally {
      this.running = false;
      if (this.read !== null) {
        this.timer = this.invalidated
          ? window.setTimeout(() => {
            this.timer = undefined;
            void this.drain();
          }, Math.max(0, this.newestAt + INVALIDATION_MS - performance.now()))
          : window.setTimeout(() => this.refresh(), this.backstop());
      }
    }
  }
}
