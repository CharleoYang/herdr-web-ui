/**
 * T-03's gate: the RPC client answers normal and fragmented replies, refuses malformed ones and old
 * protocols, times out, and errors on a missing socket — against a fixture daemon, never real herdr.
 *
 *   bun scripts/v2-diff-herdr.ts
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BINARY = join(root, "crates/ovis-v2/target/release/ovis-v2");
const dir = mkdtempSync(join(tmpdir(), "ovis-v2-rpc-"));
const socketPath = join(dir, "herdr.sock");
if (existsSync(socketPath)) rmSync(socketPath);

const listener = Bun.listen({
  unix: socketPath,
  socket: {
    data(socket, chunk) {
      const text = chunk.toString();
      for (const line of text.split("\n").filter(Boolean)) {
        let frame: { id?: string; method?: string };
        try {
          frame = JSON.parse(line) as { id?: string; method?: string };
        } catch {
          socket.write("not json\n");
          continue;
        }
        const id = frame.id ?? "?";
        switch (frame.method) {
          case "split": {
            socket.write(`{"id":"${id}","result":`);
            setTimeout(() => socket.write(`{"split":true,"protocol":22}}\n`), 60);
            break;
          }
          case "bad": {
            socket.write("this is not a reply frame\n");
            break;
          }
          case "slow": {
            setTimeout(() => socket.write(`{"id":"${id}","result":{}}\n`), 3_000);
            break;
          }
          case "ping": {
            // a normal call proves a valid protocol; the version gate is exercised with an old one
            const protocol = id === "ping" ? 21 : 22;
            socket.write(`{"id":"${id}","result":{"protocol":${protocol}}}\n`);
            break;
          }
          default: {
            socket.write(`{"id":"${id}","error":{"code":"unknown_method","message":"no such method"}}\n`);
          }
        }
      }
    },
  },
});

// async spawn: a synchronous one would block this process, so the fixture daemon could not reply
const child = Bun.spawn([BINARY, "--selftest-rpc", socketPath], { stdout: "pipe", stderr: "pipe" });
const code = await child.exited;
const out = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
process.stdout.write(out);
try { listener.stop(); } catch { /* already closed */ }
rmSync(dir, { recursive: true, force: true });

if (code !== 0 || out.includes("FAIL")) {
  console.error(`v2-diff-herdr: exit ${code}`);
  process.exit(1);
}
console.log("v2-diff-herdr: all checks passed");
