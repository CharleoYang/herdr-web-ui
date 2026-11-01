/**
 * Settings → Phone & devices → Remote access through Ovis relay, against a local Bun relay
 * (relay/bun.ts): the switch turns the relay on and the row says Online, the page itself shows no
 * QR code, the Connect a phone dialog's relay route offers to turn it on while off and shows the QR
 * code of a fresh offer with its countdown once online, New code starts another code, a code the
 * dialog's pairing code route starts refreshes the offer, and the offer's code and that route's
 * code are one and the same both ways (the server keeps one pending code and the offer reuses it), the identity reset
 * gives the PC a new server id, the switch turns the relay off and the row says Off; a device
 * paired through the relay wears the via relay pill; a serve-only install disables the switch
 * with the reason. All on pages the PC serves: that the hosted shell's Settings has no relay
 * group is checked where the app really runs under the shell, in relay-shell-browser-qa.ts (a
 * page of the PC's own build given the shell's meta boots the shell, not the app). Imported by
 * ui-regression.ts; `startRelayFixture` also serves the manual QA script.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { UsageService } from "../server/usage.ts";
import type { PairedDevice, PairingCode, RelayStatus } from "../shared/protocol.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface RelayFixture {
  readonly origin: string;
  readonly relayPort: number;
  readonly stateDir: string;
  stop(): Promise<void>;
}

/** An Ovis server whose relay link reaches a local Bun relay: the advertised wss origin is dialled as the relay's plain ws port. */
export function startRelayFixture(options: { serveOnly?: boolean } = {}): RelayFixture {
  const relay = startBunRelay({ port: 0 });
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-panel-"));
  const service = new RelayService({
    stateDir,
    relay: `wss://127.0.0.1:${relay.port}`,
    connect: (url) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    },
  });
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false,
    tailscaleServeOnly: options.serveOnly ?? false, relay: service, usage: new UsageService(undefined, []), registerBridge: false,
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    relayPort: relay.port,
    stateDir,
    async stop() {
      await service.shutdown();
      server.stop();
      await relay.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

const englishContext = async (browser: Browser, viewport = { width: 1280, height: 800 }): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  return context;
};

/** The page open on Settings → Phone & devices. */
export async function openPhoneSettings(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Phone & devices");
}

export async function checkRelayPanel(browser: Browser): Promise<void> {
  const fixtures: RelayFixture[] = [];
  const contexts: BrowserContext[] = [];
  const pageErrors: string[] = [];
  try {
    const fixture = startRelayFixture();
    fixtures.push(fixture);
    const relayState = async (): Promise<RelayStatus> => (await fetch(`${fixture.origin}/api/relay`)).json() as Promise<RelayStatus>;
    const context = await englishContext(browser);
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(page, fixture.origin);
    const dialog = page.locator(".settings-dialog");
    const group = dialog.locator('[data-section="relay"]');
    await group.getByRole("heading", { name: "Remote access through Ovis relay", exact: true }).waitFor();
    assert.ok(await group.evaluate((section) => section.previousElementSibling?.getAttribute("data-section") === "phone" && section.nextElementSibling?.getAttribute("data-section") === "devices"),
      "the relay group sits under Phone, where Portal would follow it");
    const toggle = group.getByRole("switch", { name: "Ovis relay", exact: true });
    const state = group.locator(".relay-status");
    // the QR codes are in the Connect a phone dialog, each way of connecting one of its routes
    const connect = dialog.locator('[data-section="phone"]').getByRole("button", { name: "Connect", exact: true });
    const sheet = page.getByRole("dialog", { name: "Connect a phone", exact: true });
    const relayRoute = sheet.locator('[data-route="relay"]');
    const codeRoute = sheet.locator('[data-route="code"]');
    const qr = relayRoute.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true });
    const offerAnswer = () => page.waitForResponse((response) => response.url().endsWith("/api/relay/offer") && response.request().method() === "POST");
    const closeSheet = async () => { await page.keyboard.press("Escape"); await sheet.waitFor({ state: "detached" }); };
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the relay starts off");
    assert.equal(await toggle.isEnabled(), true, "nothing blocks the relay on a plain install");
    assert.equal(await group.getByTestId("relay-owner-help").count(), 0, "the direct owner needs no relay restriction explanation");
    await state.filter({ hasText: "Off." }).waitFor();
    assert.equal(await dialog.getByRole("img").count(), 0, "the settings page itself shows no QR code");
    assert.equal((await relayState()).phase, "off");
    const closesGate = group.getByText("Turning it on closes the device gate: a new browser then needs a pairing code or the access token.", { exact: true });
    assert.equal(await closesGate.isVisible(), true, "with no token and nothing paired, the row says turning the relay on closes the gate");
    // off, the dialog's relay route offers to turn it on and shows no offer
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await relayRoute.getByRole("button", { name: "Turn on the relay", exact: true }).waitFor();
    assert.equal(await qr.count(), 0, "no offer while the relay is off");
    await closeSheet();

    // on: the server connects to the local relay, the row says so, and the dialog's offer comes by itself
    await toggle.click();
    await state.filter({ hasText: "Online. No phone connected." }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "the switch shows the relay on");
    assert.equal((await relayState()).phase, "online", "the server's relay link is online");
    await closesGate.waitFor({ state: "detached" });
    assert.equal(await dialog.getByRole("img").count(), 0, "online, the settings page still shows no QR code");
    const firstOffer = offerAnswer();
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await qr.waitFor();
    const offered = decodeOffer(((await (await firstOffer).json()) as { url: string }).url);
    assert.ok(offered !== null, "the QR code is a pairing offer");
    assert.equal(offered.relay, `wss://127.0.0.1:${fixture.relayPort}`, "the offer names the relay the server uses");
    assert.match(offered.code ?? "", /^\d{6}$/, "the offer carries a one-time pairing code");
    await relayRoute.getByText(/Expires in \d+:\d\d\./).waitFor();

    // New code: a new pairing code first (one POST pair/start), then an offer carrying that very code. Codes
    // are six random digits, so two of them are never asserted different: the offer is matched to the code
    // the server just answered, which is deterministic.
    const pairStart = () => page.waitForResponse((response) => response.url().endsWith("/api/devices/pair/start") && response.request().method() === "POST");
    const offerCode = async (answer: Promise<Response>) => {
      const offer = decodeOffer(((await (await answer).json()) as { url: string }).url);
      assert.ok(offer !== null && offer.code !== undefined, "the offer carries a pairing code");
      return offer.code;
    };
    const startedCode = async (answer: Promise<Response>) => {
      const response = await answer;
      assert.equal(response.status(), 200, "the pairing code was started");
      return ((await response.json()) as PairingCode).code;
    };
    const renewedCode = pairStart();
    const secondOffer = offerAnswer();
    await relayRoute.getByRole("button", { name: "New code", exact: true }).click();
    const renewed = await startedCode(renewedCode);
    assert.equal(await offerCode(secondOffer), renewed, "New code's offer carries the code it started");

    // the pairing code route already shows that one pending code; a code it starts itself makes the relay route
    // ask for its offer again, which carries the very code the pairing code route shows
    const shownCode = async () => (await codeRoute.locator(".devices-code").innerText()).replace(/\s+/g, "");
    await sheet.getByRole("button", { name: "Pairing code", exact: true }).click();
    await codeRoute.locator(".devices-code").waitFor();
    assert.equal(await shownCode(), renewed, "the pairing code route shows the code the relay route's New code started");
    const codeStart = pairStart();
    const resynced = offerAnswer();
    await codeRoute.getByRole("button", { name: "New code", exact: true }).click();
    const codeStarted = await startedCode(codeStart);
    assert.equal(await offerCode(resynced), codeStarted, "a code the pairing code route started refreshes the relay offer with that code");
    assert.equal(await shownCode(), codeStarted, "the relay QR carries the code the pairing code route shows");

    // New code on the relay route while the code route holds one: the code route follows it, so they stay equal
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await qr.waitFor();
    const followedStart = pairStart();
    const followedOffer = offerAnswer();
    await relayRoute.getByRole("button", { name: "New code", exact: true }).click();
    const followed = await startedCode(followedStart);
    assert.equal(await offerCode(followedOffer), followed, "the relay QR carries the code New code started");
    await page.waitForFunction(([selector, code]) => document.querySelector(selector)?.textContent?.replace(/\s+/g, "") === code, ['[data-route="code"] .devices-code', followed] as const);
    assert.equal(await shownCode(), followed, "after New code the pairing code route shows the same code as the relay QR");
    await qr.waitFor();
    await closeSheet();

    // the identity reset asks first; Cancel changes nothing, Reset gives the PC a new server id, and the next offer carries it
    const reset = group.getByRole("button", { name: "Reset", exact: true });
    const confirm = page.getByRole("alertdialog", { name: "Reset the relay identity?", exact: true });
    await reset.click();
    await confirm.getByText("Phones paired through the relay will need to scan a new code.", { exact: true }).waitFor();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await reset.click();
    await confirm.getByRole("button", { name: "Reset", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await state.filter({ hasText: "Online. No phone connected." }).waitFor();
    const afterReset = offerAnswer();
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    const rotated = decodeOffer(((await (await afterReset).json()) as { url: string }).url);
    assert.ok(rotated !== null && rotated.server_id !== offered.server_id, "the reset gives the PC a new relay identity");
    assert.notEqual(rotated.server_public_key, offered.server_public_key);
    await qr.waitFor();
    await closeSheet();
    // a phone pairs with the code of a fresh page's first offer, the one the server made with no code started on
    // the page: the page watches that code too, so the dialog closes and the Devices group names the phone
    await openPhoneSettings(page, fixture.origin);
    await state.filter({ hasText: "Online. No phone connected." }).waitFor();
    const firstOfPage = offerAnswer();
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    const pageOffer = decodeOffer(((await (await firstOfPage).json()) as { url: string }).url);
    assert.ok(pageOffer !== null && pageOffer.code !== undefined, "the fresh page's offer carries a pairing code");
    await qr.waitFor();
    const relayPaired = await fetch(`${fixture.origin}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: fixture.origin },
      body: JSON.stringify({ code: pageOffer.code, label: "Relay phone" }),
    });
    assert.equal(relayPaired.status, 204, "the phone paired with the offer's code");
    await sheet.waitFor({ state: "detached" });
    await dialog.locator('[data-section="devices"]').getByText("Paired: Relay phone.", { exact: true }).waitFor();
    await state.filter({ hasText: "Online." }).waitFor();

    // Even a Portal visitor with a saved drive role cannot control the relay (owner_only).
    const visitorContext = await englishContext(browser);
    contexts.push(visitorContext);
    const visitor = await visitorContext.newPage();
    await visitor.route("**/api/health*", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { auth: Record<string, unknown> };
      await route.fulfill({ response, json: { ...body, auth: { ...body.auth, via: "portal", role: "drive" } } });
    });
    const visitorMutations: string[] = [];
    await visitor.route("**/api/relay/**", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      visitorMutations.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 403, json: { error: { code: "owner_only", message: "Use the access token or a paired device." } } });
    });
    await openPhoneSettings(visitor, fixture.origin);
    const visitorGroup = visitor.locator('.settings-dialog [data-section="relay"]');
    await visitorGroup.locator(".relay-status").filter({ hasText: "Online." }).waitFor();
    assert.equal(await visitorGroup.getByRole("switch", { name: "Ovis relay", exact: true }).isDisabled(), true);
    const visitorHelp = visitorGroup.getByTestId("relay-owner-help");
    assert.equal(await visitorHelp.isVisible(), true, "the Portal restriction explains itself beside the disabled switch");
    assert.ok((await visitorHelp.innerText()).trim().length > 0, "the explanation is not empty");
    assert.equal(await group.getByTestId("relay-owner-help").count(), 0, "the online direct owner still has no restriction explanation");
    assert.equal(await visitorGroup.getByRole("button", { name: "Reset", exact: true }).count(), 0);
    // the visitor's dialog: the relay route reads, offers nothing, and there is no pairing code route
    await visitor.locator('.settings-dialog [data-section="phone"]').getByRole("button", { name: "Connect", exact: true }).click();
    const visitorSheet = visitor.getByRole("dialog", { name: "Connect a phone", exact: true });
    await visitorSheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await visitorSheet.locator('[data-route="relay"] .relay-status').filter({ hasText: "Online." }).waitFor();
    assert.equal(await visitorSheet.locator('[data-route="relay"]').getByRole("img").count(), 0, "a Portal visitor is shown no pairing offer");
    assert.equal(await visitorSheet.getByRole("button", { name: "Pairing code", exact: true }).count(), 0, "a Portal visitor is offered no pairing code");
    assert.deepEqual(visitorMutations, [], "a Portal visitor never requests an owner-only relay mutation");
    await visitorContext.close();

    // off: the row says so and the offer goes with the connection
    await toggle.click();
    await state.filter({ hasText: "Off." }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the switch shows the relay off");
    assert.equal((await relayState()).phase, "off", "the server's relay link is off");
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await relayRoute.getByRole("button", { name: "Turn on the relay", exact: true }).waitFor();
    assert.equal(await qr.count(), 0, "no offer while the relay is off");
    assert.equal(await relayRoute.getByRole("button", { name: "New code", exact: true }).count(), 0, "no New code while the relay is off");
    await closeSheet();

    // a device paired through the relay wears the pill: the Devices group of the PC's page lists one (the
    // real pairing of a phone through the relay is relay-shell-browser-qa.ts's)
    const paired: PairedDevice = { id: "0123456789abcdef", label: "Pixel 9", role: "drive", created_at: new Date().toISOString(), last_seen_at: null, current: false, via_relay: true };
    await page.route("**/api/devices", (route) => route.request().method() === "GET" ? route.fulfill({ json: { devices: [paired] } }) : route.continue());
    await openPhoneSettings(page, fixture.origin);
    const row = page.locator(".devices-row").filter({ hasText: "Pixel 9" });
    await row.locator(".devices-via-relay", { hasText: "via relay" }).waitFor();

    // a start that fails before the link exists (the saved choice cannot be written): the switch stays off,
    // the reason shows, and Try again starts it once the cause is gone
    const unwritable = startRelayFixture();
    fixtures.push(unwritable);
    const savedChoice = join(unwritable.stateDir, "relay", "state.json");
    mkdirSync(savedChoice, { recursive: true });
    const failedContext = await englishContext(browser);
    contexts.push(failedContext);
    const failedPage = await failedContext.newPage();
    failedPage.setDefaultTimeout(15_000);
    failedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(failedPage, unwritable.origin);
    const failedGroup = failedPage.locator('.settings-dialog [data-section="relay"]');
    const failedToggle = failedGroup.getByRole("switch", { name: "Ovis relay", exact: true });
    await failedToggle.click();
    await failedGroup.getByRole("alert").filter({ hasText: "The relay did not start: Could not start the relay." }).waitFor();
    assert.equal(await failedToggle.getAttribute("aria-checked"), "false", "a start that failed leaves the switch off");
    await failedGroup.locator(".relay-status").filter({ hasText: "Off." }).waitFor();
    rmSync(savedChoice, { recursive: true });
    await failedGroup.getByRole("button", { name: "Try again", exact: true }).click();
    await failedGroup.locator(".relay-status").filter({ hasText: "Online." }).waitFor();
    assert.equal(await failedToggle.getAttribute("aria-checked"), "true", "Try again turned the relay on");
    assert.equal(await failedGroup.getByRole("button", { name: "Try again", exact: true }).count(), 0, "no retry once it runs");

    // serve-only: the switch is there and disabled, with the reason in the row
    const serveOnly = startRelayFixture({ serveOnly: true });
    fixtures.push(serveOnly);
    const blockedContext = await englishContext(browser);
    contexts.push(blockedContext);
    const blockedPage = await blockedContext.newPage();
    blockedPage.setDefaultTimeout(15_000);
    blockedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(blockedPage, serveOnly.origin);
    const blockedGroup = blockedPage.locator('.settings-dialog [data-section="relay"]');
    const blockedToggle = blockedGroup.getByRole("switch", { name: "Ovis relay", exact: true });
    await blockedToggle.waitFor();
    assert.equal(await blockedToggle.isDisabled(), true, "a serve-only install cannot turn the relay on");
    assert.equal(await blockedToggle.getAttribute("aria-checked"), "false");
    await blockedGroup.locator(".relay-status").filter({ hasText: "Blocked: OVIS_TAILSCALE_SERVE_ONLY" }).waitFor();
    assert.equal(await blockedGroup.getByRole("img").count(), 0, "no offer on a blocked install");
    assert.equal(await blockedGroup.getByRole("button", { name: "Reset", exact: true }).count(), 0, "a serve-only install is offered no reset, which it would refuse");
    assert.equal(await blockedGroup.locator(".settings-condition").count(), 0, "a switch that cannot be turned on carries no note about turning it on");
    assert.deepEqual(pageErrors, [], "the relay panel raises no page error");
    console.log("PASS the relay panel turns the relay on and off, offers a QR code and resets the identity; a relay-paired device wears the pill and serve-only blocks the switch");
  } finally {
    for (const context of contexts) await context.close();
    for (const fixture of fixtures) await fixture.stop();
  }
}
