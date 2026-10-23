import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appName, renameManifest, renameShell, serveStatic } from "./static.ts";
import { writeAssetArchive } from "./asset-archive.ts";

// The sources Vite builds from: public/ is copied into dist/ as it is, and the meta survives the build.
const root = join(import.meta.dir, "..");
const manifest = readFileSync(join(root, "public", "manifest.webmanifest"), "utf8");
const shell = readFileSync(join(root, "index.html"), "utf8");

describe("HERDR_WEB_APP_NAME", () => {
  const previous = process.env["HERDR_WEB_APP_NAME"];
  afterEach(() => {
    if (previous === undefined) delete process.env["HERDR_WEB_APP_NAME"]; else process.env["HERDR_WEB_APP_NAME"] = previous;
  });

  it("is off when unset or blank", () => {
    delete process.env["HERDR_WEB_APP_NAME"];
    expect(appName()).toBeNull();
    process.env["HERDR_WEB_APP_NAME"] = "   ";
    expect(appName()).toBeNull();
    process.env["HERDR_WEB_APP_NAME"] = "  work laptop ";
    expect(appName()).toBe("work laptop");
  });

  it("renames the manifest and keeps everything else, the id included", () => {
    const renamed = JSON.parse(renameManifest(manifest, "laptop")) as Record<string, unknown>;
    const original = JSON.parse(manifest) as Record<string, unknown>;
    expect(renamed).toEqual({ ...original, name: "laptop", short_name: "laptop" });
    expect(renamed["id"]).toBe("/");
  });

  it("renames the iOS home-screen title in the shell and nothing else", () => {
    const renamed = renameShell(shell, "laptop");
    expect(renamed).toContain('<meta name="apple-mobile-web-app-title" content="laptop" />');
    expect(renamed.replace("content=\"laptop\"", "content=\"herdr\"")).toBe(shell);
  });

  it("escapes the name in the shell", () => {
    const renamed = renameShell(shell, `a"b<c>&$1 $&`);
    expect(renamed).toContain('content="a&quot;b&lt;c&gt;&amp;$1 $&amp;"');
  });
});

/**
 * A bundle for a PC ships the client as one archive instead of dist/'s fourteen hundred files
 * (asset-archive.ts). A browser cannot tell the difference, so these are the requests it makes,
 * answered from the archive with the same headers, sidecars and rewrites as the checkout's dist/.
 */
describe("the client archive", () => {
  const previous = process.env["HERDR_WEB_ASSETS"];
  const dirs: string[] = [];
  const created = new Map<string, Uint8Array<ArrayBuffer>>();

  function serve(): void {
    const dir = mkdtempSync(join(tmpdir(), "static-archive-"));
    dirs.push(dir);
    created.set("index.html", new TextEncoder().encode(shell.replace("<title>", "<title>archived ")));
    created.set("manifest.webmanifest", new TextEncoder().encode(manifest));
    created.set("assets/app.js", new TextEncoder().encode("console.log('identity')"));
    created.set("assets/app.js.gz", new Uint8Array([31, 139, 8, 0]));
    created.set("assets/app.js.br", new Uint8Array([0x0b, 0x02, 0x80]));
    created.set("icons/icon.png", new Uint8Array([137, 80, 78, 71, 13]));
    writeAssetArchive(join(dir, "assets.bin"), created);
    process.env["HERDR_WEB_ASSETS"] = join(dir, "assets.bin");
  }

  afterEach(() => {
    if (previous === undefined) delete process.env["HERDR_WEB_ASSETS"]; else process.env["HERDR_WEB_ASSETS"] = previous;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("serves the shell from the archive, not from a dist/ directory", async () => {
    serve();
    const response = await serveStatic("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("archived");
  });

  it("picks the sidecar the browser accepted, and 406s when it accepted none", async () => {
    serve();
    const gzip = await serveStatic("/assets/app.js", "br;q=0.5, gzip;q=0.9");
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    expect([...new Uint8Array(await gzip.arrayBuffer())]).toEqual([31, 139, 8, 0]);
    const br = await serveStatic("/assets/app.js", "br, gzip;q=0.5");
    expect(br.headers.get("content-encoding")).toBe("br");
    const none = await serveStatic("/assets/app.js", "gzip;q=0, br;q=0, *;q=0");
    expect(none.status).toBe(406);
    const identity = await serveStatic("/assets/app.js");
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(await identity.text()).toBe("console.log('identity')");
  });

  it("answers a missing asset as 404 and an unknown page as the shell", async () => {
    serve();
    expect((await serveStatic("/assets/missing.js")).status).toBe(404);
    expect((await serveStatic("/icons/missing.png")).status).toBe(404);
    const page = await serveStatic("/pane/w1B:p1");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("archived");
  });

  it("serves the manifest as built, and never serves outside the archive", async () => {
    serve();
    const response = await serveStatic("/manifest.webmanifest");
    expect(JSON.parse(await response.text())).toEqual(JSON.parse(manifest));
    const escaped = await serveStatic("/../package.json");
    expect(await escaped.text()).toContain("archived");
  });
});
