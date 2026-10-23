/**
 * The built browser client as one file.
 *
 * A remote PC install used to unpack dist/'s fourteen hundred files beside the server, on top of
 * the twenty thousand in node_modules. A security suite treats a mass extraction as dropper
 * behaviour and rolls it back - live-verified on a Windows PC with a signed Electron package -
 * and the install dies with it. So a bundle for a PC carries this archive instead: the install
 * writes a handful of files, and the PC's own herdr is untouched either way.
 *
 * The archive is gzip over a flat framing of `[u32 path length][path][u32 length][bytes]…`,
 * paths relative to dist/ and spelled as a request names them (`index.html`, `assets/x.js`).
 * A checkout has no archive and is served from dist/ as before: the archive is what a bundle
 * build writes, never something a running server creates.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The file name a bundle build writes beside the server's own entry. */
export const ASSETS_FILE = "assets.bin";

const MAGIC = new TextEncoder().encode("OVIS assets v1\n");

function frame(files: Map<string, Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array<ArrayBuffer>[] = [MAGIC];
  const name = new TextEncoder();
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const encoded = name.encode(path);
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, encoded.length);
    new DataView(header.buffer).setUint32(4, bytes.length);
    parts.push(header, encoded, bytes);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { joined.set(part, at); at += part.length; }
  return Bun.gzipSync(joined);
}

/** Throws on a truncated or foreign archive: half an archive serves half an app. */
function parse(compressed: Uint8Array<ArrayBuffer>): Map<string, Uint8Array<ArrayBuffer>> {
  const bytes = (() => {
    try { return new Uint8Array(Bun.gunzipSync(compressed)); }
    catch (error) { throw new Error(`Client archive is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  })();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < MAGIC.length || !MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error("Not a client archive");
  }
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const decoder = new TextDecoder();
  let at = MAGIC.length;
  while (at < bytes.byteLength) {
    if (at + 8 > bytes.byteLength) throw new Error("Client archive ends inside a header");
    const pathLength = view.getUint32(at);
    const length = view.getUint32(at + 4);
    at += 8;
    if (pathLength === 0 || at + pathLength > bytes.byteLength) throw new Error("Client archive ends inside a path");
    const path = decoder.decode(bytes.subarray(at, at + pathLength));
    at += pathLength;
    if (at + length > bytes.byteLength) throw new Error(`Client archive ends inside ${path}`);
    files.set(path, bytes.subarray(at, at + length));
    at += length;
  }
  return files;
}

/** Every file under `dir`, keyed by its path with forward slashes (a request's spelling). */
export function archiveFromDirectory(dir: string): Map<string, Uint8Array<ArrayBuffer>> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      files.set(relative(dir, path).split(sep).join("/"), readFileSync(path));
    }
  };
  walk(dir);
  return files;
}

export function writeAssetArchive(path: string, files: Map<string, Uint8Array<ArrayBuffer>>): void {
  writeFileSync(path, frame(files));
}

/** The archive at `path`, or null when there is none (a checkout, a bundle built before it). */
export function readAssetArchive(path: string): Map<string, Uint8Array<ArrayBuffer>> | null {
  if (!existsSync(path)) return null;
  return parse(readFileSync(path));
}
