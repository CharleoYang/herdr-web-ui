import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveFromDirectory, ASSETS_FILE, readAssetArchive, writeAssetArchive } from "./asset-archive.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "asset-archive-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the client archive", () => {
  it("keeps every file's bytes and its request spelling", () => {
    const dir = scratch();
    const archive = join(dir, ASSETS_FILE);
    const files = new Map<string, Uint8Array<ArrayBuffer>>([
      ["index.html", new TextEncoder().encode("<!doctype html><title>a</title>")],
      ["assets/app-9f2c.js", new Uint8Array([0, 1, 2, 255, 0])],
      ["assets/app-9f2c.js.gz", new Uint8Array([31, 139, 8])],
      ["icons/x.png", new Uint8Array([137, 80, 78, 71])],
    ]);
    writeAssetArchive(archive, files);
    const read = readAssetArchive(archive);
    expect([...read!.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, bytes] of files) expect([...(read!.get(path) ?? [])]).toEqual([...bytes]);
  });

  it("walks a directory into forward-slash paths", () => {
    const dir = scratch();
    mkdirSync(join(dir, "assets", "deep"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "shell");
    writeFileSync(join(dir, "assets", "app.js"), "code");
    writeFileSync(join(dir, "assets", "deep", "x.woff2"), "font");
    expect([...archiveFromDirectory(dir).keys()].sort()).toEqual(["assets/app.js", "assets/deep/x.woff2", "index.html"]);
  });

  it("is null where no archive was shipped", () => {
    expect(readAssetArchive(join(scratch(), ASSETS_FILE))).toBeNull();
  });

  it("refuses a truncated archive instead of serving half an app", () => {
    const dir = scratch();
    const archive = join(dir, ASSETS_FILE);
    writeAssetArchive(archive, new Map([["index.html", new TextEncoder().encode("shell")]]));
    const bytes = Bun.file(archive);
    return bytes.arrayBuffer().then((whole) => {
      writeFileSync(archive, new Uint8Array(whole).subarray(0, whole.byteLength - 4));
      expect(() => readAssetArchive(archive)).toThrow();
    });
  });

  it("refuses bytes that are not an archive", () => {
    const dir = scratch();
    const archive = join(dir, ASSETS_FILE);
    writeFileSync(archive, Bun.gzipSync(new TextEncoder().encode("not an archive at all")));
    expect(() => readAssetArchive(archive)).toThrow(/Not a client archive/);
  });
});
