/** Real App + Bun bridge + Chromium. Only delay/drop real traffic; never invent API success data.
 * Run after `bun run build`. Evidence survives cleanup in UI_EVIDENCE_DIR (or .omo/evidence).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page, Request } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

assert.notEqual(process.env.HERDR_TEST_LIVE, "1", "browser QA must never use a live session");
assert.notEqual(process.env.HERDR_TEST_MODE, "unit", "real herdr is required");
// Darwin's sockaddr_un is only 104 bytes; never derive the socket from /var/folders.
const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rr-")));
const workspace = join(root, "repo");
const evidence = resolve(process.env.UI_EVIDENCE_DIR || `.omo/evidence/roster-refresh-${Date.now()}`);
mkdirSync(evidence, { recursive: true });
const oldEnv = { ...process.env };
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.HERDR_TEST_SESSION = `roster-${process.pid}`;
delete process.env.HERDR_SOCKET;
type RequestRecord = { id: number; url: string; responseUrl?: string; origin: string; path: string; search: string; method: string; time: number; status?: number; error?: string; done?: boolean; fault?: "stream-close" | "stream-outage" | "stale-roster" };
const requests = new Map<Request, RequestRecord>();
const network: unknown[] = [];
const consoleLog: { time: number; type: string; text: string; location: { url: string; lineNumber: number; columnNumber: number }; classification?: string; requestId?: number }[] = [];
const baselineExceptions: unknown[] = [];
const runtime: Record<string, unknown> = { root, workspace, evidence };
const checks: string[] = [];
const unexpected: string[] = [];
let bridge: { port: number; stop: () => unknown } | undefined;
let relay: { port: number; stop: (closeActiveConnections?: boolean) => unknown } | undefined;
let browser: Browser | undefined;
let evidencePage: Page | undefined;
let shutdownHerdr = false;
let releaseHeld = () => {};
const streams = new Set<{ close: () => void; release: () => void }>();
let holdSnapshots = true;
let unavailable = false;
function closeStreams() {
  for (const record of requests.values()) {
    if (record.path === "/api/machines/events" && !record.done) record.fault = "stream-close";
  }
  for (const stream of [...streams]) stream.close();
}
function accepted(record: RequestRecord): string | undefined {
  const url = new URL(record.url);
  if (record.origin === runtime.origin && record.method === "GET" && record.path === "/api/telemetry" && !url.search && record.status === 404 && !record.error) return "optional telemetry disabled (server/index.ts createServer contract)";
  if (record.path === "/api/machines/events" && record.method === "GET" && !url.search
    && (record.origin === runtime.origin || record.origin === runtime.relayOrigin)) {
    if (record.fault === "stream-outage" && record.status === 503 && !record.error) return "controlled stream outage";
    if (record.fault && record.error && ["net::ERR_FAILED", "net::ERR_ABORTED", "net::ERR_EMPTY_RESPONSE"].includes(record.error)) return "controlled stream transport closure";
  }
  if (record.fault === "stale-roster" && record.origin === runtime.origin && record.path === "/api/machines" && !url.search && record.method === "GET" && record.error === "net::ERR_FAILED") return "controlled stale roster transport failure";
}
let classified = false;
function classifyErrors() {
  if (classified) return;
  classified = true;
  const candidates = [...requests.values()].filter((record) => record.error || (record.status ?? 0) >= 400);
  for (const record of candidates) {
    const reason = accepted(record);
    if (reason) baselineExceptions.push({ requestId: record.id, url: record.url, status: record.status, error: record.error, reason });
    else unexpected.push(`request ${record.id}: ${record.error ?? record.status} ${record.url}`);
  }
  const correlated = new Set<number>();
  for (const message of consoleLog) {
    if (message.type !== "error") continue;
    // Chromium resource diagnostics only: exact URL + status/error + one request per message.
    // Application exceptions/logged errors never become baseline exceptions.
    const record = candidates.find((item) => !correlated.has(item.id) && (item.url === message.location.url || item.responseUrl === message.location.url) && accepted(item)
      && (item.error ? message.text === `Failed to load resource: ${item.error}`
        : new RegExp(`^Failed to load resource: the server responded with a status of ${item.status} \\(.*\\)$`).test(message.text)));
    if (record) {
      correlated.add(record.id); message.requestId = record.id; message.classification = accepted(record);
    } else unexpected.push(`console ${message.location.url}: ${message.text}`);
  }
}
let streamConnections = 0;
let forwardedSnapshots = 0;
let heldSnapshots = 0;
const encoder = new TextEncoder();
const rosterReads: number[] = [];
const healthReads: number[] = [];
const authReads: number[] = [];
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}
async function observe(page: Page, ms: number) {
  // A bounded observation window proves the absence/cadence of network activity, not UI readiness.
  await page.waitForTimeout(ms);
}
async function visibility(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    // App-level visibility-policy control, NOT Chromium OS/background throttling coverage.
    const state = window as unknown as { qaHidden: boolean };
    state.qaHidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
try {
  mkdirSync(workspace);
  writeFileSync(join(workspace, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg>');
  for (const args of [["init", "--quiet"], ["add", "favicon.svg"], ["-c", "user.name=Roster QA", "-c", "user.email=roster@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Owned QA fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: workspace });
    assert.equal(result.exitCode, 0, result.stderr.toString());
  }
  // Deliberate module-loading test boundary: private env must precede socket initializers.
  shutdownHerdr = true;
  await import("./test-herdr.ts");
  const socket = process.env.HERDR_SOCKET;
  // Module-loading boundary is intentional: herdr/server imports capture socket configuration,
  // so the private environment must exist before any of their module initializers run.
  assert.ok(socket && socket.startsWith(root), "owned private herdr socket required");
  runtime.socket = socket;
  const { createServer } = await import("../server/index.ts");
  const { herdrRpc, sessionSnapshot, workspaceClose } = await import("../server/herdr/client.ts");
  // test-herdr creates a resident workspace in the user's home. Replace only that private
  // session's initial workspace before exposing the bridge; every visible workspace is owned.
  const resident = await sessionSnapshot(socket);
  const owned = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "roster-browser-owned", cwd: workspace, focus: false }, socket,
  );
  for (const initial of resident.workspaces) await workspaceClose(initial.workspace_id, socket);
  const pane = owned.root_pane.pane_id;
  bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "bridge") });
  const origin = `http://127.0.0.1:${bridge.port}`;
  runtime.origin = origin; runtime.pane = pane;
  // A streaming network fault relay: forwards original SSE bytes, holding only full snapshots.
  // Preferences/heartbeats remain real, so EventSource can open without a roster baseline.
  relay = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (unavailable) return new Response("QA stream outage", { status: 503 });
    const abort = new AbortController();
    const upstream = await fetch(`${origin}/api/machines/events`, { signal: abort.signal });
    assert.equal(upstream.status, 200);
    streamConnections++;
    let pending: string | undefined;
    let closed = false;
    let finish = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (frame: string) => { if (!closed) controller.enqueue(encoder.encode(frame)); };
        const connection = {
          close() {
            if (closed) return;
            closed = true; abort.abort(); streams.delete(connection);
            try { controller.close(); } catch { /* cancellation already closed it */ }
          },
          release() { if (pending) { send(pending); forwardedSnapshots++; pending = undefined; } },
        };
        finish = connection.close;
        streams.add(connection);
        request.signal.addEventListener("abort", finish, { once: true });
        void (async () => {
          const reader = upstream.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (!closed) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let end: number;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end + 2); buffer = buffer.slice(end + 2);
                const line = frame.split("\n").find((part) => part.startsWith("data: "));
                const payload: unknown = line ? JSON.parse(line.slice(6)) : null;
                const type = payload && typeof payload === "object" && "type" in payload ? payload.type : null;
                if (type === "machines" && holdSnapshots) { pending = frame; heldSnapshots++; }
                else { send(frame); if (type === "machines") forwardedSnapshots++; }
              }
            }
          } catch (error) { if (!closed) unexpected.push(`SSE relay: ${String(error)}`); }
          finally { reader.releaseLock(); request.signal.removeEventListener("abort", finish); finish(); }
        })();
      }, cancel() { finish(); },
    });
    return new Response(body, { headers: { ...Object.fromEntries(upstream.headers), "access-control-allow-origin": origin, "access-control-allow-credentials": "true" } });
  } });
  runtime.relayOrigin = `http://127.0.0.1:${relay.port}`;
  runtime.pageUrl = `${origin}/?pane=${encodeURIComponent(pane)}`;
  writeFileSync(join(evidence, "runtime.json"), JSON.stringify(runtime, null, 2));
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", serviceWorkers: "block" });
  await context.addInitScript(() => {
    const state = window as unknown as { qaHidden: boolean; qaStreamOpens: number; qaStreamErrors: number; qaSnapshots: number };
    state.qaHidden = false; state.qaStreamOpens = 0; state.qaStreamErrors = 0; state.qaSnapshots = 0;
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => state.qaHidden ? "hidden" : "visible" });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => state.qaHidden });
    const NativeSource = window.EventSource;
    window.EventSource = class extends NativeSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("open", () => state.qaStreamOpens++);
        this.addEventListener("error", () => state.qaStreamErrors++);
        this.addEventListener("message", (event) => { if (JSON.parse(event.data).type === "machines") state.qaSnapshots++; });
      }
    };
  });
  const page = await context.newPage();
  evidencePage = page;
  page.setDefaultTimeout(15_000);
  await page.route("**/api/machines/events", (route) => route.continue({ url: `http://127.0.0.1:${relay!.port}/api/machines/events` }));
  page.on("request", (request) => {
    const url = new URL(request.url());
    const record: RequestRecord = { id: requests.size + 1, url: url.href, origin: url.origin, path: url.pathname, search: url.search, method: request.method(), time: Date.now() };
    if (url.pathname === "/api/machines/events" && unavailable) record.fault = "stream-outage";
    requests.set(request, record);
    network.push({ event: "request", ...record, searchParams: [...url.searchParams] });
    if (url.origin !== origin || request.method() !== "GET") return;
    if (url.pathname === "/api/machines" && !url.search) rosterReads.push(record.time);
    // src/lib/api.ts: fetchHealth and fetchBridgeHealth are two independent URLs.
    if (url.pathname === "/api/health" && !url.search) healthReads.push(record.time);
    if (url.pathname === "/api/health" && url.searchParams.get("scope") === "bridge" && [...url.searchParams].length === 1) authReads.push(record.time);
  });
  page.on("response", (response) => {
    const record = requests.get(response.request())!;
    record.status = response.status(); record.responseUrl = response.url();
    network.push({ event: "response", time: Date.now(), requestId: record.id, url: response.url(), status: record.status });
  });
  page.on("requestfinished", (request) => { requests.get(request)!.done = true; });
  page.on("requestfailed", (request) => {
    const record = requests.get(request)!;
    record.error = request.failure()?.errorText ?? "unknown transport failure"; record.done = true;
    network.push({ event: "failed", time: Date.now(), requestId: record.id, url: request.url(), error: record.error, fault: record.fault });
  });
  page.on("pageerror", (error) => {
    consoleLog.push({ time: Date.now(), type: "pageerror", text: error.stack ?? error.message, location: { url: "", lineNumber: 0, columnNumber: 0 } });
    unexpected.push(`pageerror: ${error.stack ?? error.message}`);
  });
  page.on("console", (message) => consoleLog.push({ time: Date.now(), type: message.type(), text: message.text(), location: message.location() }));
  const streamState = () => page.evaluate(() => {
    const state = window as unknown as { qaStreamOpens: number; qaStreamErrors: number; qaSnapshots: number };
    return { opens: state.qaStreamOpens, errors: state.qaStreamErrors, snapshots: state.qaSnapshots };
  });
  await page.goto(runtime.pageUrl as string);
  await until(async () => (await streamState()).opens > 0 && heldSnapshots > 0, "open stream with withheld real initial snapshot");
  await page.locator(`.pane-select[title^="${pane} —"]`).waitFor();
  const initial = rosterReads.length;
  await observe(page, 10_500);
  assert.ok(rosterReads.length >= initial + 2, "open without a full snapshot must retain 5s roster fallback");
  assert.equal((await streamState()).snapshots, 0);
  checks.push("open-without-snapshot fallback");
  holdSnapshots = false; for (const stream of streams) stream.release();
  await until(async () => (await streamState()).snapshots > 0, "actual initial snapshot received");
  const healthyStart = rosterReads.length;
  const healthStart = healthReads.length; const authStart = authReads.length;
  await observe(page, 10_500);
  assert.equal(rosterReads.length, healthyStart, "healthy SSE suppresses redundant 5s roster GET");
  assert.ok(healthReads.length >= healthStart + 2, "health keeps 5s cadence");
  assert.ok(authReads.length >= authStart + 2, "auth keeps 5s cadence");
  const lastRead = rosterReads.at(-1)!;
  await until(() => rosterReads.length > healthyStart, "authoritative healthy REST backstop", 30_000);
  assert.ok(rosterReads.at(-1)! - lastRead <= 30_000, "healthy visible REST gap is at most 30s");
  checks.push("healthy suppression, health/auth independence, bounded backstop");
  await page.screenshot({ path: join(evidence, "healthy.png") });

  // A reconnect is open but has not received its own full baseline: previous health cannot leak.
  holdSnapshots = true;
  const oldConnection = streamConnections;
  const oldOpens = (await streamState()).opens;
  const oldErrors = (await streamState()).errors;
  closeStreams();
  await until(async () => (await streamState()).errors > oldErrors, "native SSE error");
  await until(async () => streamConnections > oldConnection && (await streamState()).opens > oldOpens, "native SSE reconnect");
  const reconnectReads = rosterReads.length;
  await observe(page, 10_500);
  assert.ok(rosterReads.length >= reconnectReads + 2, "reconnect without current snapshot must use fallback");
  const priorSnapshots = (await streamState()).snapshots;
  holdSnapshots = false; for (const stream of streams) stream.release();
  await until(async () => (await streamState()).snapshots > priorSnapshots, "reconnected stream receives real baseline");
  const recovered = rosterReads.length;
  await observe(page, 10_500);
  assert.equal(rosterReads.length, recovered, "current full snapshot restores event-led refresh");
  checks.push("stream error, reconnect baseline reset, recovery");

  // Hold an old real response, deliver a newer real status, then release success and failure.
  const badge = page.locator(".pane-item.is-selected .badge");
  for (const failure of [false, true]) {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "blocked" }, socket);
    await until(async () => await badge.getAttribute("data-status") === "blocked", "real blocked baseline");
    let captured = false; let finished = false;
    const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
    releaseHeld = releaseGate;
    await page.route("**/api/machines", async (route) => {
      if (captured) { await route.continue(); return; }
      const response = await route.fetch(); captured = true;
      await gate;
      if (failure) {
        requests.get(route.request())!.fault = "stale-roster";
        await route.abort("failed");
      } else await route.fulfill({ response });
      finished = true;
    });
    await visibility(page, false);
    await until(() => captured, "capture older real HTTP roster");
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" }, socket);
    await until(async () => await badge.getAttribute("data-status") === "working", "new real streamed status wins");
    const failed = failure ? page.waitForEvent("requestfailed", (request) => requests.get(request)?.fault === "stale-roster") : undefined;
    releaseHeld(); await until(() => finished, "release stale response");
    if (failed) await failed;
    await page.evaluate(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      await promise;
    });
    assert.equal(await badge.getAttribute("data-status"), "working", "stale HTTP success/failure cannot replace newer status");
    assert.equal(await page.getByText("Failed to fetch", { exact: false }).count(), 0, "stale HTTP error is fenced");
    releaseHeld = () => {};
    await page.unroute("**/api/machines");
  }
  checks.push("stale HTTP success and failure fencing");

  // Hidden pages do not read even when herdr sends a roster-changing event burst.
  await visibility(page, true);
  const hiddenCounts = [rosterReads.length, healthReads.length, authReads.length];
  await herdrRpc("workspace.create", { label: "roster-hidden-added", cwd: workspace, focus: false }, socket);
  await observe(page, 10_500);
  assert.deepEqual([rosterReads.length, healthReads.length, authReads.length], hiddenCounts, "hidden page does not perform background reads");
  await visibility(page, false);
  await until(() => rosterReads.length > hiddenCounts[0]!, "visibility restore forces fresh roster");
  await page.getByText("roster-hidden-added", { exact: true }).first().waitFor();
  checks.push("hidden pause, event burst, forced visibility restore, visible roster correctness");

  // Explicit user creation still reloads even with a healthy stream.
  await page.getByRole("button", { name: /^New workspace on / }).click();
  const dialog = page.getByRole("dialog", { name: /^New workspace/ });
  await dialog.getByLabel(/^Directory/).fill(workspace);
  await dialog.getByLabel(/^Name/).fill("roster-explicit-created");
  const beforeAction = rosterReads.length;
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await until(() => rosterReads.length > beforeAction, "explicit roster-changing action forces GET");
  await page.getByText("roster-explicit-created", { exact: true }).first().waitFor();
  const native = await sessionSnapshot(socket);
  const created = native.workspaces.find((item) => item.label === "roster-explicit-created");
  assert.ok(created, "explicit workspace exists in native authority");
  const createdPane = native.panes.find((item) => item.workspace_id === created.workspace_id);
  assert.ok(createdPane, "explicit workspace has a native pane");
  const selected = page.locator(".pane-item.is-selected .pane-select");
  await until(async () => (await selected.getAttribute("title"))?.startsWith(`${createdPane.pane_id} —`) === true, "explicit action selects its native workspace pane");
  checks.push("explicit roster action reload and selection");
  await page.screenshot({ path: join(evidence, "restored.png") });

  unavailable = true;
  closeStreams();
  const unavailableReads = rosterReads.length;
  await observe(page, 10_500);
  assert.ok(rosterReads.length >= unavailableReads + 2, "unavailable SSE retains 5s fallback");
  checks.push("unavailable stream negative control");
  classifyErrors();
  assert.deepEqual(unexpected, [], "no unexpected browser/network errors");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ status: "PASS", checks, runtime, baselineExceptions, rosterReads, healthReads, authReads, streamConnections, forwardedSnapshots }, null, 2));
  console.log(JSON.stringify({ status: "PASS", evidence, checks }));
} catch (error) {
  await evidencePage?.screenshot({ path: join(evidence, "failure.png") }).catch(() => undefined);
  classifyErrors();
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ status: "FAIL", checks, runtime, baselineExceptions, error: String(error), unexpected }, null, 2));
  throw error;
} finally {
  const cleanupErrors: string[] = [];
  const cleanup = async (label: string, action: () => unknown) => {
    try { await action(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); }
  };
  await cleanup("release held HTTP", releaseHeld);
  await cleanup("browser", () => browser?.close());
  await cleanup("streams", () => { for (const stream of [...streams]) stream.close(); });
  await cleanup("relay", () => relay?.stop(true));
  await cleanup("bridge", () => bridge?.stop());
  let stopped = !shutdownHerdr;
  await cleanup("private herdr", () => {
    if (!shutdownHerdr) return;
    const binary = process.env.HERDR_WEB_HERDR_BIN || Bun.which("herdr");
    assert.ok(binary, "private herdr stop requires its binary");
    // Inherited HERDR_SOCKET_PATH belongs to the invoking pane, not this session.
    const stopEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR|OMO|SENPI|PI)_/.test(name)));
    const result = Bun.spawnSync([binary, "--session", process.env.HERDR_TEST_SESSION!, "server", "stop"], { env: stopEnv });
    assert.equal(result.exitCode, 0, `${result.stdout.toString()}${result.stderr.toString()}`);
    stopped = true;
  });
  await cleanup("evidence", () => {
    writeFileSync(join(evidence, "network.json"), JSON.stringify(network, null, 2));
    writeFileSync(join(evidence, "console.json"), JSON.stringify(consoleLog, null, 2));
    writeFileSync(join(evidence, "requests.json"), JSON.stringify([...requests.values()], null, 2));
    writeFileSync(join(evidence, "runtime.json"), JSON.stringify(runtime, null, 2));
  });
  // Keep the private socket/config available for diagnosis if its server could not stop.
  if (stopped) await cleanup("owned root", () => rmSync(root, { recursive: true, force: true }));
  for (const name of ["XDG_CONFIG_HOME", "HERDR_TEST_SESSION", "HERDR_SOCKET", "TMPDIR"]) {
    if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name];
  }
  writeFileSync(join(evidence, "cleanup.json"), JSON.stringify({ stopped, retainedRoot: stopped ? null : root, errors: cleanupErrors }, null, 2));
  if (cleanupErrors.length) {
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ status: "FAIL", checks, runtime, baselineExceptions, unexpected, cleanupErrors }, null, 2));
    throw new Error(cleanupErrors.join("; "));
  }
}
