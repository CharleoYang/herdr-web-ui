/**
 * Test support, never served: a file thread (`file-worker.ts`) whose tasks can be held. It runs
 * each task for real, then
 * - never answers a task whose path ends in `/stuck`, nor an `open` of one ending in `/held-open`
 *   (its stat answers), as a call that never returns would not;
 * - with a `gate` (a SharedArrayBuffer of two Int32 cells), records in cell 1 the descriptor the
 *   task opened (`Atomics.notify` on it; -2 when it opened none) and answers only once cell 0 is
 *   set, as a call that returns late would;
 * - with a `readGate` (two Int32 cells and a FIFO's path), stops inside the file read itself: it
 *   records the descriptor being read in cell 1 (`Atomics.notify`), then opens the FIFO for reading,
 *   a real system call that blocks until a writer opens it (which ending the thread cannot cut
 *   short), and then reads, as a read on a stalled disk would;
 * - with an `authorizeGate` (the same shape), stops once the file is authorized, before the task
 *   answers, as a check on a stalled disk would: it opens the FIFO (read and write, which never
 *   waits), records the descriptor the task named in its cell (`opened`) in cell 1, then blocks in a
 *   read of the FIFO. Opened before cell 1 is set, the FIFO always has this reader once the test
 *   sees it, so the test's release (a write that does not wait) never waits for this thread.
 */
import { closeSync, constants, openSync, readSync } from "node:fs";

import { type FileTask, runFileTask, transferablesOf } from "./file-tasks.ts";
import { pageFileHooks } from "./file-view.ts";

declare const self: Worker;

type Gate = { cells: SharedArrayBuffer; fifo: string };

self.onmessage = (event: MessageEvent<FileTask & { gate?: SharedArrayBuffer; readGate?: Gate; authorizeGate?: Gate }>) => {
  const task = event.data;
  if ("path" in task && (task.path.endsWith("/stuck") || (task.op === "open" && task.path.endsWith("/held-open")))) return;
  const readGate = task.readGate;
  if (readGate !== undefined) {
    pageFileHooks.readSync = (fd, buffer, offset, length, position) => {
      const cells = new Int32Array(readGate.cells);
      Atomics.store(cells, 1, fd);
      Atomics.notify(cells, 1);
      closeSync(openSync(readGate.fifo, "r"));
      return readSync(fd, buffer, offset, length, position);
    };
  }
  const authorizeGate = task.authorizeGate;
  if (authorizeGate !== undefined) {
    pageFileHooks.afterAuthorize = () => {
      const cells = new Int32Array(authorizeGate.cells);
      const fifo = openSync(authorizeGate.fifo, constants.O_RDWR);
      Atomics.store(cells, 1, "opened" in task && task.opened !== undefined ? task.opened[0]! : -2);
      Atomics.notify(cells, 1);
      try { readSync(fifo, new Uint8Array(1), 0, 1, null); } finally { closeSync(fifo); }
    };
  }
  let result;
  try { result = runFileTask(task); } finally { delete pageFileHooks.readSync; delete pageFileHooks.afterAuthorize; }
  if (task.gate !== undefined) {
    const cells = new Int32Array(task.gate);
    // the descriptor the thread opened, handed over or not (the cell `open` names it in)
    const opened = task.op === "open" && task.opened !== undefined ? task.opened[0]! : -1;
    const fd = result !== null && typeof result === "object" && "fd" in result && result.fd !== null ? result.fd : opened;
    Atomics.store(cells, 1, fd >= 0 ? fd : -2);
    Atomics.notify(cells, 1);
    Atomics.wait(cells, 0, 0);
  }
  postMessage({ result }, transferablesOf(result));
};
