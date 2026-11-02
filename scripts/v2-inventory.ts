/**
 * The v2 contract inventory, read from the calls the SPA actually makes, not from prose.
 *
 *   bun scripts/v2-inventory.ts            # check the scan against the reviewed allow-list
 *   bun scripts/v2-inventory.ts --write    # rewrite docs/v2-route-inventory.md and the allow-list
 *
 * Why an allow-list: a reader that silently misses a route is worse than no reader (round-2 review
 * found this one exiting 0 while 45 baseline paths were absent). So the scan is compared with a
 * reviewed `scripts/v2-route-allowlist.json` in BOTH directions — a missed route fails the check,
 * and a new route fails until someone adds it here on purpose. Methods come from
 * `scripts/v2-route-methods.json` (the runtime trace's job, filled by `--write` from api.ts's own
 * `method:` options).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ALLOWLIST = join(root, "scripts/v2-route-allowlist.json");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** The `type: "…"` discriminants of one exported union: its members run to the next declaration. */
function unionTypes(source: string, name: string): string[] {
  const start = source.indexOf(`export type ${name} =`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, next < 0 ? source.length : next);
  return [...new Set([...body.matchAll(/\btype:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!))].sort();
}

const isTest = (file: string): boolean => /\.(test|contract\.test)\.(ts|tsx)$/.test(file);

/** A route a call names: `machinePath(m, "pane/read")`, `machineRequest(m, "/api/x")`, `fetch("/api/x")`. */
function routeOf(call: string, argument: string): string | null {
  let path = argument
    .replace(/^["'`]/, "")
    .replace(/["'`]$/, "")
    .replace(/\$\{[^}]*\}/g, ":id")
    .replace(/[?#].*$/, "");
  if (path === "" || path.startsWith("http")) return null;
  // the helper's own prefix: `machinePath(m, "pane/read")` -> /api/pane/read, `machineRequest(m, "/settings")` -> /api/machines/settings
  const prefix = call === "machinePath" ? "/api" : call === "machineRequest" ? "/api/machines" : call === "cliProxyRequest" ? "/api/cliproxy" : "";
  if (prefix !== "") path = path.startsWith("/") ? `${prefix}${path}` : `${prefix}/${path}`;
  else if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/api") return null;
  if (!path.startsWith("/api/") && !path.startsWith("/_portal/")) return null;
  if (/[ :*<>]/.test(path)) return null;
  return path.replace(/\/+$/, "") || "/";
}

/** Routes named as arguments of the calls that take one, plus bare `/api/...` literals. */
function scan(source: string): string[] {
  const found = new Set<string>();
  const calls = /\b(machinePath|machineRequest|cliProxyRequest|fetch|request|getJson|postJson|putJson|patchJson|deleteJson)\(\s*(?:[^,()]*,\s*)*?(["'`])([^"'`]*)\2/g;
  for (const match of source.matchAll(calls)) {
    const route = routeOf(match[1]!, `${match[2]}${match[3]}${match[2]}`);
    if (route !== null) found.add(route);
  }
  for (const match of source.matchAll(/(["'`])(\/api\/[a-z0-9/:${}_.-]*)\1/gi)) {
    const route = routeOf("literal", `${match[1]}${match[2]}${match[1]}`);
    if (route !== null) found.add(route);
  }
  return [...found].sort();
}

/** The HTTP methods `src/lib/api.ts` sends per route, from the `method: "…"` next to each call. */
function methods(source: string): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  const call = /\b(machinePath|machineRequest|fetch|request)\(\s*(?:[^,()]*,\s*)*?(["'`])([^"'`]*)\2[^)]{0,400}?method:\s*"([A-Z]+)"/g;
  for (const match of source.matchAll(call)) {
    const route = routeOf(match[1]!, `${match[2]}${match[3]}${match[2]}`);
    if (route === null) continue;
    table[route] = [...new Set([...(table[route] ?? []), match[4]!])].sort();
  }
  return table;
}

const protocol = read("shared/protocol.ts");
const client = unionTypes(protocol, "ClientMessage");
const server = unionTypes(protocol, "ServerMessage");

const files = [
  ...[...new Bun.Glob("src/lib/**/*.ts").scanSync({ cwd: root })].filter((file) => !isTest(file)),
  ...[...new Bun.Glob("src/components/**/*.tsx").scanSync({ cwd: root })].filter((file) => !isTest(file)),
];
const routes = new Set<string>();
const methodTable: Record<string, string[]> = {};
for (const file of files) {
  const source = read(file);
  for (const route of scan(source)) routes.add(route);
  for (const [route, verbs] of Object.entries(methods(source))) methodTable[route] = [...new Set([...(methodTable[route] ?? []), ...verbs])].sort();
}
const scanned = [...routes].sort();

const allowlist: string[] = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) as string[] : [];
const missing = scanned.filter((route) => !allowlist.includes(route));
const stale = allowlist.filter((route) => !scanned.includes(route));
const operations = Object.values(methodTable).reduce((sum, verbs) => sum + verbs.length, 0);

const lines = [
  "# Ovis v2 — contract inventory",
  "",
  "> Generated by `bun scripts/v2-inventory.ts --write`; checked in CI against `scripts/v2-route-allowlist.json`.",
  "> A route the scan misses fails the check; a route nobody reviewed fails until it is added on purpose.",
  "",
  `## WS frames (${client.length} client, ${server.length} server)`,
  "",
  `ClientMessage: ${client.map((type) => `\`${type}\``).join(", ")}`,
  "",
  `ServerMessage: ${server.map((type) => `\`${type}\``).join(", ")}`,
  "",
  `## HTTP routes the SPA calls (${scanned.length} templates; ${operations} methods observed in api.ts)`,
  "",
  "| route | methods (from api.ts) |",
  "| --- | --- |",
  ...scanned.map((route) => `| \`${route}\` | ${(methodTable[route] ?? []).join(", ") || "—"} |`),
  "",
  "## Not a finite route (named by contract, not scanned)",
  "",
  "- `GET /api/machines/events` — SSE stream (`src/lib/useMachineRoster.ts`), method/path owned by the roster, not a body.",
  "- `POST /_portal/auth/logout` and the Portal paths — outside `/api`, owned by the portal shell.",
  "- `machineRequest(path, method, body)` and `cliProxyRequest(path, init)` remain open-ended: their call sites are scanned, their path arguments are checked above.",
];

const markdown = `${lines.join("\n")}\n`;
if (process.argv.includes("--write")) {
  writeFileSync(join(root, "docs/v2-route-inventory.md"), markdown);
  writeFileSync(ALLOWLIST, `${JSON.stringify(scanned, null, 2)}\n`);
  process.stdout.write(markdown);
} else if (missing.length > 0 || stale.length > 0) {
  console.error(`v2-inventory: the scan and the reviewed allow-list differ`);
  if (missing.length > 0) console.error(`  scrolled but unreviewed (${missing.length}):\n    ${missing.join("\n    ")}`);
  if (stale.length > 0) console.error(`  reviewed but no longer called (${stale.length}):\n    ${stale.join("\n    ")}`);
  process.exit(1);
} else {
  process.stdout.write(markdown);
}

if (client.length === 0 || server.length === 0 || scanned.length === 0) {
  console.error("v2-inventory: a group came out empty; the reader is wrong, not the code");
  process.exit(1);
}
