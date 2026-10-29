/**
 * Pi-only streaming metadata reader. Completed clipped labels are cached by checked path and
 * descriptor identity/size/timestamps; transcript content and unfinished scans are never cached.
 *
 * Transcript reads/stats are asynchronous on the checked descriptor, never a reopened path.
 * At most two readers run and 32 wait. A listing has one two-second deadline, including queue time; each
 * caller keeps its own deadline, even when another listing reads the same file. Calls already in
 * the filesystem retain their descriptor/slot until they return, then close it, never mid-read.
 *
 * Reads use 64 KiB chunks and a bounded JSON projection, not whole-line/transcript buffers. The
 * deadline bounds scan work rather than a fixed head or per-file byte cutoff. A file changing
 * during the scan, a read failure or a deadline returns a retryable error, never incomplete labels.
 * Retrying starts fresh; there is no retained progress or automatic background scan.
 */
import { closeSync, fstat, read, type BigIntStats } from "node:fs";

import { PiLabelParser, type PiLabel } from "./pi-session-label.ts";

export const PI_CHUNK_BYTES = 64 * 1024;
export const PI_READ_DEADLINE_MS = 2000;
export const PI_READERS = 2;
const WAITING = 32;
const CACHE_ENTRIES = 256;

export class PiMetadataBusy extends Error {
  constructor() { super("Pi sessions could not be read right now. Try again."); }
}

const descriptorStat = (fd: number): Promise<BigIntStats> => new Promise((done, fail) => {
  fstat(fd, { bigint: true }, (error, stat) => error ? fail(error) : done(stat));
});
const descriptorRead = (fd: number, buffer: Buffer, length: number, position: number): Promise<number> => new Promise((done, fail) => {
  read(fd, buffer, 0, length, position, (error, bytes) => error ? fail(error) : done(bytes));
});

interface Task {
  /** Each asynchronous step of an opener must check the owning task before starting more I/O. */
  open: (checkActive: () => void) => number | Promise<number>;
  deadline: number;
  done: (label: PiLabel | null) => void;
  fail: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  expired: boolean;
  cache: { path: string; scope: string } | null;
}

interface ReaderOptions {
  /** Descriptor-only seam for counting I/O and holding a read in tests. */
  read?: typeof descriptorRead;
}

export class PiSessionReader {
  private tasks = new Set<Task>();
  private queue: Task[] = [];
  private active = 0;
  private working = new Set<Promise<void>>();
  private stopped = false;
  private labels = new Map<string, { key: string; scope: string; label: PiLabel | null }>();
  constructor(private readonly options: ReaderOptions = {}) {}

  /** In-flight scans stay independent; only a completed label for an unchanged checked file is reused. */
  read(open: Task["open"], deadline: number, cache: Task["cache"] = null): Promise<PiLabel | null> {
    if (this.stopped || performance.now() >= deadline || (this.active >= PI_READERS && this.queue.length >= WAITING)) return Promise.reject(new PiMetadataBusy());
    const { promise, resolve, reject } = Promise.withResolvers<PiLabel | null>();
    const task: Task = {
      open, deadline, cache, done: resolve, fail: reject, expired: false,
      timer: setTimeout(() => {
        task.expired = true;
        task.fail(new PiMetadataBusy());
        const at = this.queue.indexOf(task);
        if (at >= 0) { this.queue.splice(at, 1); this.tasks.delete(task); }
      }, Math.max(0, deadline - performance.now())),
    };
    this.tasks.add(task);
    if (this.active < PI_READERS) this.start(task);
    else this.queue.push(task);
    return promise;
  }

  private start(task: Task): void {
    this.active++;
    const finish = () => {
      clearTimeout(task.timer);
      this.tasks.delete(task);
      this.active--;
      const next = this.queue.shift();
      if (next) this.start(next);
    };
    const work = this.scan(task).then(
      (label) => { finish(); task.done(label); },
      (error: unknown) => { finish(); task.fail(error); },
    );
    this.working.add(work);
    void work.then(() => this.working.delete(work));
  }

  private async scan(task: Task): Promise<PiLabel | null> {
    let fd: number | undefined;
    const checkActive = () => {
      if (task.expired || this.stopped || performance.now() >= task.deadline) throw new PiMetadataBusy();
    };
    try {
      checkActive();
      // The opener owns its descriptor until validation succeeds; cancellation closes it there.
      fd = await task.open(checkActive);
      checkActive();
      const before = await descriptorStat(fd);
      checkActive();
      // Nanoseconds strengthen the requested millisecond key on filesystems that expose them.
      const key = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, before.mtimeNs, before.ctimeNs].join(":");
      const cached = task.cache === null ? undefined : this.labels.get(task.cache.path);
      if (task.cache !== null) this.labels.delete(task.cache.path);
      if (cached?.key === key && task.cache !== null) {
        this.labels.set(task.cache.path, { ...cached, scope: task.cache.scope });
        return cached.label;
      }
      const buffer = Buffer.alloc(PI_CHUNK_BYTES);
      const parser = new PiLabelParser();
      let position = 0;
      const end = Number(before.size);
      while (position < end) {
        checkActive();
        const length = Math.min(buffer.length, end - position);
        const count = await (this.options.read ?? descriptorRead)(fd, buffer, length, position);
        checkActive();
        if (count <= 0 || count > length) throw new PiMetadataBusy();
        parser.feed(buffer.subarray(0, count));
        position += count;
      }
      checkActive();
      const after = await descriptorStat(fd);
      checkActive();
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new PiMetadataBusy();
      const label = parser.finish();
      if (task.cache !== null) {
        this.labels.delete(task.cache.path);
        this.labels.set(task.cache.path, { key, scope: task.cache.scope, label });
        if (this.labels.size > CACHE_ENTRIES) {
          const oldest = this.labels.keys().next().value;
          if (oldest !== undefined) this.labels.delete(oldest);
        }
      }
      return label;
    } catch (error) {
      // An opener can reject after its deadline too; do not turn that timeout into a missing row.
      checkActive();
      if (task.cache !== null) this.labels.delete(task.cache.path);
      if (error instanceof PiMetadataBusy) throw error;
      // Unreadable/deleted files list nothing, as the other agents do. A failed read retries.
      if (fd !== undefined) throw new PiMetadataBusy();
      return null;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Refuse queued/in-flight requests now; each active descriptor closes once its filesystem call ends. */
  close(): void {
    this.stopped = true;
    this.labels.clear();
    for (const task of this.tasks) {
      task.expired = true;
      clearTimeout(task.timer);
      task.fail(new PiMetadataBusy());
    }
    for (const task of this.queue) this.tasks.delete(task);
    this.queue = [];
  }

  /** Wait until actual filesystem calls/descriptor cleanup finish, even after callers were refused. */
  async idle(): Promise<void> { await Promise.all([...this.working]); }

  /** Drop labels no longer discovered in these listing folders; other stores keep their own entries. */
  retain(scope: string, paths: readonly string[]): void {
    const listed = new Set(paths);
    for (const [path, entry] of this.labels) {
      if (entry.scope === scope && !listed.has(path)) this.labels.delete(path);
    }
  }

  /** Cache count only, never the retained labels or paths (regression instrumentation). */
  cacheSize(): number { return this.labels.size; }

  /** Resource counts only, never names/prompts/paths (regression instrumentation). */
  size(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.queue.length };
  }
}

/** Direct callers share admission and clipped labels; createServer owns its reader and cache. */
export const defaultPiSessionReader = new PiSessionReader();
