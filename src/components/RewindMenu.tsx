import { useCallback, useEffect, useState } from "react";
import { Undo2 } from "lucide-react";

import { ApiError, fetchRewindPoints, rewindPane } from "../lib/api.ts";
import { rewindChoices, rewindErrorText, rewindWhen } from "../lib/rewindChoices.ts";
import type { RewindList, RewindPoint, RewindRestore } from "../../shared/rewind.ts";
import { useT } from "../lib/i18n.ts";

/**
 * Claude Code's checkpoints for this pane, as its own session records them.
 *
 * A running agent is not driven from here: #1577 removed a chat-side rewind that read the terminal's
 * dialog and typed into it, after its walk broke on a Claude update, and settled on handing that to
 * the terminal. So a live pane offers the same handoff as before, and the one action that restores
 * from the chat is the direct one — which only exists once the agent has ended (`offline`).
 */
export function RewindMenu({ paneId, onClose, onRestored, onTerminal }: {
  paneId: string;
  onClose: () => void;
  /** A restore went through: the chat must read the conversation again. */
  onRestored: () => void;
  /** The pane's own terminal, where a live agent's `/rewind` is run by the user. */
  onTerminal: () => void;
}) {
  const t = useT();
  const [list, setList] = useState<RewindList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<RewindPoint | null>(null);
  const [done, setDone] = useState<RewindPoint | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRewindPoints(paneId).then(
      (points) => { if (!cancelled) setList(points); },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof ApiError ? rewindErrorText(cause.code ?? "") : t("Couldn't read this session's checkpoints")); },
    );
    return () => { cancelled = true; };
  }, [paneId, t]);

  const restore = useCallback(async (point: RewindPoint, mode: RewindRestore) => {
    setBusy(point);
    setError(null);
    try {
      await rewindPane({ pane_id: paneId, message_id: point.message_id, restore: mode });
      setDone(point);
      onRestored();
    } catch (cause: unknown) {
      setError(cause instanceof ApiError ? rewindErrorText(cause.code ?? "") : t("The rewind did not go through"));
    } finally {
      setBusy(null);
    }
  }, [paneId, onRestored, t]);

  const points = list?.points ?? [];
  return <div className="rewind-menu" role="dialog" aria-label={t("Rewind to a message")}>
    <header className="rewind-menu-head">
      <span><Undo2 aria-hidden="true" /> {t("Rewind to a message")}</span>
      <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}>×</button>
    </header>
    {list === null && error === null && <p className="chat-inline-state" role="status">{t("Loading…")}</p>}
    {list !== null && points.length === 0 && (
      <p className="chat-inline-state">{list.reason === "no_session" ? t("This pane's Claude session cannot be read") : t("This conversation has no checkpoint yet")}</p>
    )}
    {points.length > 0 && <ol className="rewind-menu-list">
      {[...points].reverse().map((point) => {
        // newest first: the usual place to go back to is the last thing said
        const choices = rewindChoices(point, list?.mode ?? "terminal");
        const working = busy === point;
        return <li key={point.message_id} className="rewind-menu-point">
          <p className="rewind-menu-prompt">{point.prompt}</p>
          <p className="rewind-menu-meta">
            {rewindWhen(point.at)}
            {point.files === 0 ? ` · ${t("No code restore")}` : ` · ${t("{count} files", { count: String(point.files) })}`}
            {done === point && ` · ${t("Restored")}`}
          </p>
          <div className="rewind-menu-actions">
            {(list?.mode ?? "terminal") === "offline"
              ? choices.map((choice) => <button key={choice.restore} type="button" disabled={working} onClick={() => void restore(point, choice.restore)}>{
                // spelled out, not passed through: the dictionaries are keyed by the literal
                choice.label === "Restore code and conversation" ? t("Restore code and conversation")
                  : choice.label === "Restore code" ? t("Restore code")
                    : t("Restore conversation")
              }</button>)
              : <button type="button" onClick={onTerminal}>{t("Rewind in terminal")}</button>}
          </div>
        </li>;
      })}
    </ol>}
    {error !== null && <p className="chat-inline-state" role="alert">{error}</p>}
  </div>;
}
