import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, X } from "lucide-react";

import "./ConnectPhoneDialog.css";
import "./DevicesPanel.css";

import { startPairing } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { announcePairingCode, inRelayShell, PAIRING_CODE_EVENT, type RelayState } from "../lib/useRelay.ts";
import type { PairingCode } from "../../shared/protocol.ts";
import { PhonePanel } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, RelayPairing, statusText } from "./RelayPanel.tsx";
import { Segmented } from "./SettingsControls.tsx";

const README_PHONE = "https://github.com/devswha/ovis#on-your-phone";
const README_SAFETY = "https://github.com/devswha/ovis#access-and-safety";

export type ConnectRoute = "relay" | "tailscale" | "code";

/** whether the relay can be offered here at all: a server with the route, a direct page, not the hosted shell */
export const relayOffered = (relay: RelayState): boolean => !relay.unsupported && relay.status !== null && !inRelayShell();

/** the way the dialog opens on: Tailscale once it already works, else the relay, which needs nothing installed */
export function defaultRoute(plan: PhonePlan, relay: RelayState): ConnectRoute {
  if (plan.kind === "here" || plan.kind === "served") return "tailscale";
  return relayOffered(relay) ? "relay" : "tailscale";
}

export interface ConnectPhoneDialogProps {
  route: ConnectRoute;
  plan: PhonePlan;
  loading: boolean;
  onRefresh: () => void;
  /** an address a phone can open now, for the pairing code's QR code; null shows the code alone */
  pairUrl: string | null;
  relay: RelayState;
  /** a watching device or a Portal visitor: it reads, and starts nothing */
  readOnly: boolean;
  /** turning the relay on closes the open device gate (RelayPanel's same note) */
  closesGate: boolean;
  /** a Portal visitor may not start pairing codes (the server refuses it) */
  canPair: boolean;
  /** Pair a device opened it: the code route starts a code at once, as the button always did */
  startCode?: boolean;
  onClose: () => void;
}

/**
 * Settings → Phone & devices → Connect a phone: the ways a phone reaches this PC, one at a time,
 * and the QR codes, which show only here. The Ovis relay (from anywhere, nothing to install),
 * Tailscale (the PC's tailnet address, or the command that publishes it) and a pairing code (a
 * phone that can already open this address: the same Wi-Fi, a tunnel, a proxy). The settings page
 * keeps the relay's switch and the device list; the long explanations wait behind How it works.
 */
export function ConnectPhoneDialog({ route: initial, plan, loading, onRefresh, pairUrl, relay, readOnly, closesGate, canPair, startCode = false, onClose }: ConnectPhoneDialogProps) {
  const t = useT();
  const id = useId();
  const [route, setRoute] = useState<ConnectRoute>(initial);
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const offered = relayOffered(relay);
  const routes: { value: ConnectRoute; label: string }[] = [
    ...(offered ? [{ value: "relay" as const, label: t("Ovis relay") }] : []),
    { value: "tailscale", label: "Tailscale" },
    ...(canPair ? [{ value: "code" as const, label: t("Pairing code") }] : []),
  ];
  const shown = routes.some((option) => option.value === route) ? route : routes[0]!.value;

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Connect a phone")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body connect-phone-body">
          {routes.length > 1 && <Segmented label={t("How the phone connects")} value={shown} options={routes} onChange={setRoute} />}
          {/* every way stays mounted while the dialog is up, the others hidden: the relay's QR and the pairing
              code follow each other's New code (the server keeps one pending code), as they did side by side */}
          {offered && <div className="connect-phone-route" data-route="relay" hidden={shown !== "relay"}><RelayRoute relay={relay} readOnly={readOnly} closesGate={closesGate} recommended={plan.kind !== "here" && plan.kind !== "served"} /></div>}
          <div className="connect-phone-route" data-route="tailscale" hidden={shown !== "tailscale"}><PhonePanel plan={plan} loading={loading} onRefresh={onRefresh} /></div>
          {canPair && <div className="connect-phone-route" data-route="code" hidden={shown !== "code"}><CodeRoute pairUrl={pairUrl} startAtOnce={startCode && initial === "code"} /></div>}
          <details className="settings-details connect-phone-how">
            <summary><span className="settings-details-toggle">{t("How it works")}</span></summary>
            <p className="settings-hint">{t("Use Ovis from your phone anywhere, without Tailscale. Traffic is end-to-end encrypted; the relay sees only when and how much.")}</p>
            <p className="settings-hint">{t("Your own Tailscale devices get in as you.")} {t("With an access token set, each asks for it once. Anyone else's device, or a LAN or public address, needs pairing: Devices, below.")}</p>
            <p className="settings-hint">{t("A paired device gets in on its own until you revoke it here.")} {t("It gets in from anywhere it can reach this server. A code comes from this screen on the PC or on a device already paired, or from the pair command in the PC's terminal.")}</p>
            <p className="settings-hint"><a href={README_PHONE} target="_blank" rel="noreferrer">{t("Other routes")}</a> · <a href={README_SAFETY} target="_blank" rel="noreferrer">{t("Access and safety")}</a></p>
          </details>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The relay's way: turn it on here when it is off, then its pairing QR code once it is online. */
function RelayRoute({ relay, readOnly, closesGate, recommended }: { relay: RelayState; readOnly: boolean; closesGate: boolean; recommended: boolean }) {
  const t = useT();
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  if (status === null) return null;
  const notStarted = status.blocked === null && status.phase === "off" && status.error !== null;
  const start = async () => {
    setError(null);
    try { await request("start"); } catch (reason) { setError(failureText(reason)); }
  };
  return (
    <div className="connect-phone-relay">
      {recommended && <p className="settings-description">{t("Recommended: works from anywhere, with nothing to install on the phone.")}</p>}
      <p className="relay-status" role="status">{statusText(t, status)}</p>
      {readOnly && <p className="settings-condition">{t("Only the PC's owner can control the relay, using a direct connection. Open Ovis on the PC or at its direct address.")}</p>}
      {notStarted && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: status.error })}</p>}
      {!readOnly && status.blocked === null && status.phase === "off" && (
        <>
          {closesGate && <p className="settings-condition">{t("Turning it on closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
          <div className="phone-actions">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void start()}>
              {notStarted ? <><RefreshCw aria-hidden="true" />{t("Try again")}</> : t("Turn on the relay")}
            </button>
          </div>
        </>
      )}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {status.phase === "online" && !readOnly && <RelayPairing />}
    </div>
  );
}

/**
 * A pairing code for a phone that can already open this address, with the QR code that opens it
 * with the code filled in. The server keeps one pending code: a code started here is announced, so
 * the Devices group watches for the phone it lets in (and closes the dialog once it is in), and the
 * relay's offer carries the same code.
 */
function CodeRoute({ pairUrl, startAtOnce }: { pairUrl: string | null; startAtOnce: boolean }) {
  const t = useT();
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const announcing = useRef(false);

  useEffect(() => {
    const onCode = (event: Event) => { if (!announcing.current) setCode((event as CustomEvent<PairingCode>).detail); };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  const pair = async () => {
    setError(null);
    try {
      const fresh = await startPairing();
      setCode(fresh);
      announcing.current = true;
      try { announcePairingCode(fresh); } finally { announcing.current = false; }
    } catch (reason) { setError(failureText(reason)); }
  };

  // once per opening from Pair a device; switching back to this route later waits for the button
  const started = useRef(false);
  useEffect(() => {
    if (!startAtOnce || started.current) return;
    started.current = true;
    void pair();
  }, [startAtOnce]);

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;
  return (
    <div className="connect-phone-code">
      {code === null ? (
        <>
          <p className="settings-description">{t("For a phone that can already open this address: on the same Wi-Fi, or through a tunnel or proxy.")}</p>
          <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pair()}>{t("Get a pairing code")}</button></div>
        </>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} />}
          <div>
            <p className="settings-label">{t("On the other device, enter this code")}</p>
            <p className="devices-code">{spaced}</p>
            <p className="settings-description">
              {t(qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in." : "Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}
            </p>
            {qrValue !== null && (
              <p className="devices-link">
                <span className="settings-description">{t("Or send this link to it:")}</span>
                <a ref={linkRef} href={qrValue}>{qrValue}</a>
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(qrValue, linkRef.current).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } })}>{t(copied ? "Copied" : "Copy")}</button>
              </p>
            )}
            <div className="phone-actions">
              <button type="button" className="btn" onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
            </div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
