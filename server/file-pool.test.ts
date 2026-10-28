import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { FileBusyError, filePoolSize, fileTask, fileThreadsClosed, holdFilePool, setFilePoolOptions } from "./file-pool.ts";
import type { FileTask, OpenedFile } from "./file-tasks.ts";

const fake = new URL("./file-worker.fake.ts", import.meta.url);
/** Bun's Atomics.waitAsync (ES2024), which this project's library types predate. */
const waitAsync = (Atomics as unknown as { waitAsync: (cells: Int32Array, index: number, value: number, timeout: number) => { async: boolean; value: Promise<string> | string } }).waitAsync;

/** A held answer: the thread runs its task, then waits until `release`. */
const gate = () => {
  const cells = new Int32Array(new SharedArrayBuffer(8));
  cells[1] = -1;
  return {
    buffer: cells.buffer as SharedArrayBuffer,
    release: () => { Atomics.store(cells, 0, 1); Atomics.notify(cells, 0); },
    /** The descriptor the held thread opened (-2: none), once its task ran: its thread may start late. */
    async ran(): Promise<number> {
      const waited = waitAsync(cells, 1, -1, 10_000);
      if ((waited.async ? await waited.value : waited.value) === "timed-out") throw new Error("the held thread never ran its task");
      return cells[1]!;
    },
  };
};
const held = (task: FileTask, buffer: SharedArrayBuffer): FileTask & { gate: SharedArrayBuffer } => ({ ...task, gate: buffer });
/** A whole GET with no Range. */
const whole = { range: null, ifRange: false };

describe("file threads", () => {
  let root: string;
  let file: string;
  /** larger than one read: opened with fastDiskMs -1 (a slow disk), its descriptor is handed over */
  let big: string;
  const setUp = (options: Parameters<typeof setFilePoolOptions>[0]) => {
    root = mkdtempSync(join(tmpdir(), "ovis-file-pool-"));
    file = join(root, "notes.txt");
    writeFileSync(file, "hello");
    big = join(root, "big.bin");
    writeFileSync(big, Buffer.alloc(300 * 1024, 1));
    setFilePoolOptions({ worker: fake, ...options });
  };
  afterEach(() => {
    setFilePoolOptions();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses at once past its threads and its waiting places, and runs the rest once threads answer", async () => {
    setUp({ workers: 2, waiting: 1, deadlineMs: 30_000 });
    const hold = gate();
    const running = [fileTask<FileInfo | null>(held({ op: "info", path: file }, hold.buffer)), fileTask<FileInfo | null>(held({ op: "info", path: file }, hold.buffer))];
    const waiting = fileTask<FileInfo | null>({ op: "info", path: file });
    expect(filePoolSize()).toEqual({ threads: 2, idle: 0, waiting: 1 });
    await expect(fileTask({ op: "info", path: file })).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    for (const answer of await Promise.all([...running, waiting])) expect(answer).toMatchObject({ name: "notes.txt", size: 5 });
    expect(filePoolSize()).toEqual({ threads: 2, idle: 2, waiting: 0 });
  });

  it("refuses a task at its deadline, and keeps its thread taken until the call returns", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 200 });
    const hold = gate();
    await expect(fileTask(held({ op: "info", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    // the call has not returned: a task after it waits for its thread, never gets it, and is refused in turn
    await expect(fileTask({ op: "info", path: file })).rejects.toBeInstanceOf(FileBusyError);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
    const next = fileTask<FileInfo | null>({ op: "info", path: file });
    hold.release();
    expect(await next).toMatchObject({ size: 5 });
    expect(filePoolSize()).toEqual({ threads: 1, idle: 1, waiting: 0 });
  });

  it("closes a descriptor a late answer opened, and frees its thread for the next task", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 300 });
    const hold = gate();
    await expect(fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    // the deadline may pass before the thread even starts: the open still comes, and its answer late
    const fd = await hold.ran();
    expect(fd).toBeGreaterThanOrEqual(0);
    // the next task waits for that thread, which answers once released; by then the late answer was handled
    const next = fileTask<FileInfo | null>({ op: "info", path: file });
    hold.release();
    expect(await next).toMatchObject({ size: 5 });
    expect(() => fstatSync(fd)).toThrow();
  });

  it("refuses at once when its request goes away, and closes what the thread opened only once it answers", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 30_000 });
    const hold = gate();
    const abort = new AbortController();
    const opening = fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer), abort.signal);
    // the thread is in its task (a read on a stalled disk, as far as the request can tell) when the client leaves
    const fd = await hold.ran();
    abort.abort();
    await expect(opening).rejects.toThrow("cancelled");
    // the thread has not answered: its descriptor is not closed under it, and its thread stays taken
    expect(fstatSync(fd).size).toBe(300 * 1024);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
    // a task waiting for a thread when its request goes away leaves the queue
    const queued = new AbortController();
    const waiting = fileTask({ op: "info", path: file }, queued.signal);
    expect(filePoolSize().waiting).toBe(1);
    queued.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    expect(filePoolSize().waiting).toBe(0);
    const next = fileTask<FileInfo | null>({ op: "info", path: file });
    hold.release();
    expect(await next).toMatchObject({ size: 5 });
    expect(() => fstatSync(fd)).toThrow();
    await expect(fileTask({ op: "info", path: file }, AbortSignal.abort())).rejects.toThrow("cancelled");
  });

  it("reads a body of one read on its thread, inside the deadline, and hands over only a larger one", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const small = await fileTask<OpenedFile | null>({ op: "open", path: file, get: whole });
    expect(small).toMatchObject({ size: 5, range: null, fd: null });
    expect(new TextDecoder().decode(small!.bytes!)).toBe("hello");
    const part = await fileTask<OpenedFile | null>({ op: "open", path: big, get: { range: "bytes=10-19", ifRange: false } });
    expect(part).toMatchObject({ size: 300 * 1024, range: [10, 19], fd: null });
    expect(part!.bytes!.length).toBe(10);
    expect(await fileTask({ op: "open", path: big, get: { range: `bytes=${300 * 1024}-`, ifRange: false } })).toMatchObject({ range: "unsatisfiable", bytes: null, fd: null });
    expect(await fileTask({ op: "open", path: big, get: null })).toMatchObject({ size: 300 * 1024, bytes: null, fd: null });
    // a fast disk: sent whole, from the path, with its length; a slow one: its descriptor handed over to stream
    expect(await fileTask({ op: "open", path: big, get: whole })).toMatchObject({ size: 300 * 1024, range: null, bytes: null, fd: null, fast: true });
    const stream = await fileTask<OpenedFile | null>({ op: "open", path: big, get: whole, fastDiskMs: -1 });
    expect(stream).toMatchObject({ range: null, bytes: null, fast: false });
    expect(fstatSync(stream!.fd!).size).toBe(300 * 1024);
    closeSync(stream!.fd!);
  });

  it("gives a folder walk, many calls rather than one, the longer deadline", async () => {
    setUp({ workers: 2, waiting: 0, deadlineMs: 150, longDeadlineMs: 30_000 });
    const hold = gate();
    const walk = fileTask<string[]>(held({ op: "walk", cwd: root }, hold.buffer));
    // a one-call task held as long is refused at the short deadline; the walk is still waited for
    await expect(fileTask(held({ op: "info", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    expect([...await walk].sort()).toEqual(["big.bin", "notes.txt"]);
  });

  it("closes a descriptor whose thread is ended before it answers", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const hold = gate();
    const opening = fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer));
    const fd = await hold.ran();
    expect(fstatSync(fd).size).toBe(300 * 1024);
    // the thread is ended mid-task, as one that fails would be: what it opened is never handed over
    setFilePoolOptions();
    await expect(opening).rejects.toThrow("replaced");
    await fileThreadsClosed();
    expect(() => fstatSync(fd)).toThrow();
  });

  it("keeps a descriptor its thread is reading open until that thread is gone, when the last server stops", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const fifo = join(root, "stall");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const release = holdFilePool();
    const hold = gate();
    const reading = fileTask<OpenedFile | null>({ op: "open", path: file, get: whole, readGate: { cells: hold.buffer, fifo } } as FileTask);
    // the thread is inside the read of `file`, blocked in a system call ending it cannot cut short
    const fd = await hold.ran();
    release();
    await expect(reading).rejects.toThrow("stopped");
    // the request is answered, but the read still uses the descriptor: it stays open, and its number is not handed out again
    expect(fstatSync(fd).size).toBe(5);
    const other = openSync(big, "r");
    expect(other).not.toBe(fd);
    closeSync(other);
    // the read returns, the thread is gone, and only then is its descriptor closed
    closeSync(openSync(fifo, "w"));
    await fileThreadsClosed();
    expect(() => fstatSync(fd)).toThrow();
  });

  it("ends its threads, a busy one too, when the last server holding them stops", async () => {
    setUp({ workers: 2, waiting: 0, deadlineMs: 30_000 });
    const [first, second] = [holdFilePool(), holdFilePool()];
    const hold = gate();
    const opening = fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer));
    const fd = await hold.ran();
    expect(await fileTask({ op: "info", path: file })).toMatchObject({ size: 5 });
    expect(filePoolSize().threads).toBe(2);
    first();
    first();
    // another server still holds them
    expect(filePoolSize().threads).toBe(2);
    second();
    expect(filePoolSize()).toEqual({ threads: 0, idle: 0, waiting: 0 });
    await expect(opening).rejects.toThrow("stopped");
    await fileThreadsClosed();
    expect(() => fstatSync(fd)).toThrow();
    // a later server starts new ones
    const later = holdFilePool();
    expect(await fileTask({ op: "info", path: file })).toMatchObject({ size: 5 });
    later();
  });

  it("refuses a task waiting for a thread at its deadline", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 200 });
    const [stuck, waiting] = await Promise.allSettled([fileTask({ op: "info", path: join(root, "stuck") }), fileTask({ op: "info", path: file })]);
    expect(stuck.status === "rejected" && stuck.reason).toBeInstanceOf(FileBusyError);
    expect(waiting.status === "rejected" && waiting.reason).toBeInstanceOf(FileBusyError);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
  });

  it("runs every task on a real thread and answers as the calling thread would", async () => {
    setFilePoolOptions();
    root = mkdtempSync(join(tmpdir(), "ovis-file-pool-"));
    writeFileSync(join(root, "a.log"), "line\n");
    expect(await fileTask<FileInfo | null>({ op: "info", path: join(root, "a.log") })).toMatchObject({ name: "a.log", kind: "text", size: 5 });
    expect(await fileTask({ op: "info", path: root })).toBeNull();
    expect(await fileTask({ op: "walk", cwd: root })).toEqual(["a.log"]);
    const opened = await fileTask<OpenedFile | null>({ op: "open", path: join(root, "a.log"), get: whole });
    expect(opened).toMatchObject({ size: 5, fd: null });
    expect(new TextDecoder().decode(opened!.bytes!)).toBe("line\n");
  });
});
