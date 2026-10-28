import { constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { sep } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { byteRange, fileInfo, pageFileHooks, pageWithLocalFiles, pathsByName, release, STREAM_CHUNK_BYTES, type PageMedia, type PageMediaGrant } from "./file-view.ts";
import { walkFiles } from "./files.ts";

/**
 * What a file thread (`file-pool.ts`) does: each synchronous filesystem step of the file routes,
 * named so that a request can ask for it and wait without holding the server's thread.
 */
export type FileTask =
  | { op: "info"; path: string }
  | { op: "named"; path: string }
  | { op: "within"; paths: string[]; folder: string }
  | { op: "walk"; cwd: string }
  | { op: "render"; path: string; media: PageMedia | null }
  /**
   * `get`: a GET's Range and whether it came with If-Range (null for a HEAD, which reads nothing);
   * `opened`: where the thread names the descriptor as soon as it has it (`file-pool.ts`);
   * `fastDiskMs`: how quickly the disk must answer for a large body to be sent whole (tests)
   */
  | { op: "open"; path: string; get: { range: string | null; ifRange: boolean } | null; opened?: Int32Array<SharedArrayBuffer>; fastDiskMs?: number };

/** A page drawn with its own files put into it (null when it cannot be), and the media addresses that render gave out. */
export interface RenderedPage { html: Uint8Array<ArrayBuffer> | null; grants: PageMediaGrant[] }
/**
 * A file opened to serve: its size, the range a GET asked for (`byteRange`), and its bytes when
 * they fit in one read; for a larger body, either `fast` (its disk answered at once: send it whole
 * from the path, with its length) or its descriptor to stream it from (a slow disk). None of these
 * for a HEAD or an unsatisfiable range.
 */
export interface OpenedFile { size: number; range: [number, number] | "unsatisfiable" | null; bytes: Uint8Array<ArrayBuffer> | null; fd: number | null; fast: boolean }

/**
 * How quickly opening, describing and reading the start of a large file must go for its disk to
 * count as fast (a local disk takes a few milliseconds; a FUSE or network share that waits on each
 * call takes far longer).
 */
export const FAST_DISK_MS = 50;
const PROBE_BYTES = 64 * 1024;

export type FileTaskResult = FileInfo | FileInfo[] | string[] | boolean | RenderedPage | OpenedFile | null;

export function runFileTask(task: FileTask): FileTaskResult {
  switch (task.op) {
    case "info": return fileInfo(task.path);
    case "named": return pathsByName(task.path).map(fileInfo).filter((info) => info !== null);
    case "within": return within(task.paths, task.folder);
    case "walk": return walkFiles(task.cwd);
    case "render": return render(task.path, task.media);
    case "open": return open(task.path, task.get, task.opened, task.fastDiskMs ?? FAST_DISK_MS);
  }
}

/** What a thread hands over rather than copies: a rendered page's or a small file's bytes. */
export function transferablesOf(result: FileTaskResult): ArrayBuffer[] {
  if (result !== null && typeof result === "object" && "html" in result && result.html !== null) return [result.html.buffer];
  if (result !== null && typeof result === "object" && "bytes" in result && result.bytes !== null) return [result.bytes.buffer];
  return [];
}

/** Every path, symlinks followed, lies in `folder`; false for a missing or unreadable one. */
function within(paths: string[], folder: string): boolean {
  try {
    const root = realpathSync(folder) + sep;
    return paths.every((path) => realpathSync(path).startsWith(root));
  } catch { return false; }
}

function render(path: string, media: PageMedia | null): RenderedPage {
  const grants: PageMediaGrant[] = [];
  const html = pageWithLocalFiles(path, media, (grant) => grants.push(grant));
  return { html: html === null ? null : new TextEncoder().encode(html), grants };
}

/**
 * The file at `path` opened, and as much of the answer as is known before any header is sent: the
 * range, and the bytes of a body that fits in one read, so that every wait on the disk before the
 * headers runs here, inside the task's deadline. A larger body is sent with its length when its
 * disk answered at once (Bun sizes only a file body, which it reads on the server's thread, as it
 * always did); from a slow disk it is streamed from the descriptor handed over, without a length
 * (Bun sends any stream body chunked), so that disk never holds the server's thread. O_NONBLOCK,
 * so a FIFO put where the file was is not waited on.
 */
function open(path: string, get: { range: string | null; ifRange: boolean } | null, opened: Int32Array<SharedArrayBuffer> | undefined, fastDiskMs: number): OpenedFile | null {
  const began = performance.now();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  if (opened !== undefined) Atomics.store(opened, 0, fd);
  pageFileHooks.opened?.(fd);
  // not handed over: closed by whoever takes it from the cell first, here or `abandon` (file-pool.ts)
  const close = () => { if (opened === undefined || Atomics.compareExchange(opened, 0, fd, -1) === fd) release(fd); };
  let size: number;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) { close(); return null; }
    size = stat.size;
  } catch { close(); return null; }
  const range = get === null ? null : byteRange(get.range, get.ifRange, size);
  if (get === null || range === "unsatisfiable") { close(); return { size, range, bytes: null, fd: null, fast: false }; }
  const [start, end] = range ?? [0, size - 1];
  const length = end - start + 1;
  if (length > STREAM_CHUNK_BYTES) {
    try { (pageFileHooks.readSync ?? readSync)(fd, new Uint8Array(PROBE_BYTES), 0, PROBE_BYTES, start); } catch { close(); return null; }
    if (performance.now() - began >= fastDiskMs) return { size, range, bytes: null, fd, fast: false };
    close();
    return { size, range, bytes: null, fd: null, fast: true };
  }
  const bytes = new Uint8Array(length);
  let got = 0;
  try {
    while (got < length) {
      const read = (pageFileHooks.readSync ?? readSync)(fd, bytes, got, length - got, start + got);
      if (read === 0) break;
      got += read;
    }
  } catch { got = -1; }
  close();
  // shorter than it was when opened, or unreadable: gone, as a file that vanished
  return got === length ? { size, range, bytes, fd: null, fast: false } : null;
}
