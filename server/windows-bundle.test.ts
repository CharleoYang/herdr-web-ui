import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveFromDirectory, ASSETS_FILE, writeAssetArchive } from "./asset-archive.ts";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "windows-bundle-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The runtime layout a bundle has: one file of server code, one archive of client files. */
function stage(): string {
  const dir = scratch();
  mkdirSync(join(dir, "server"), { recursive: true });
  const build = Bun.spawnSync([process.execPath, "build", join(root, "server/remote-entry.ts"), "--target=bun", "--outfile", join(dir, "server/bridge.js")], { cwd: root });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  const client = scratch();
  mkdirSync(join(client, "assets"), { recursive: true });
  writeFileSync(join(client, "index.html"), "<!doctype html><title>bridge</title>");
  writeFileSync(join(client, "assets", "app.js"), "console.log(1)");
  writeAssetArchive(join(dir, ASSETS_FILE), archiveFromDirectory(client));
  return dir;
}

function selfCheck(dir: string): { code: number; out: string } {
  const run = Bun.spawnSync([process.execPath, join(dir, "server/bridge.js"), "--version"], { cwd: dir, stderr: "pipe", stdout: "pipe" });
  return { code: run.exitCode ?? -1, out: `${run.stdout.toString()}${run.stderr.toString()}` };
}

describe("the bridge a PC installs", () => {
  it("runs from one bundled file and reads its client archive", () => {
    const dir = stage();
    const check = selfCheck(dir);
    expect(check.code).toBe(0);
    expect(check.out).toContain(`herdr-web-ui bridge ${REMOTE_BUNDLE_VERSION}`);
    expect(check.out).toContain("2 client files");
  });

  // The install's smoke test is only worth running if it can fail: an archive that did not arrive
  // must stop the install before a runtime is activated without its client.
  it("fails its self-check when the client archive is missing", () => {
    const dir = stage();
    rmSync(join(dir, ASSETS_FILE));
    const check = selfCheck(dir);
    expect(check.code).not.toBe(0);
    expect(check.out).toContain(ASSETS_FILE);
  });

  it("fails its self-check when the archive cannot be read", () => {
    const dir = stage();
    writeFileSync(join(dir, ASSETS_FILE), Bun.gzipSync(new TextEncoder().encode("half a download")));
    const check = selfCheck(dir);
    expect(check.code).not.toBe(0);
    expect(check.out).toContain("Not a client archive");
  });
});
