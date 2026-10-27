import { useEffect, useState } from "react";
import { ChevronDown, MessageSquare, X } from "lucide-react";
import type { BtwTopic, BtwTurn } from "../../shared/omp-btw.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useBtwVisibility } from "../lib/btwVisibility.ts";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";
import { TurnTime } from "./TurnTime.tsx";
import "./BtwPanel.css";
import { ApiError } from "../lib/api.ts";

function BtwTopicRow({ topic }: { topic: BtwTopic }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const turns = [topic, ...(topic.followUps ?? [])];
  const latest = turns[turns.length - 1]!;
  const label = (status: BtwTurn["status"]): string => {
    switch (status) {
      case "running": return t("Working…");
      case "complete": return t("Done");
      case "cancelled": return t("cancelled");
      case "error": return t("Error");
      case "interrupted": return t("Interrupted");
    }
  };
  return <details className="chat-btw-topic" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <ChevronDown aria-hidden="true" />
      <span className="chat-btw-question-preview">{topic.question.split("\n")[0]}</span>
      <span className={`chat-btw-status is-${latest.status}`}>{label(latest.status)}</span>
    </summary>
    {open && <div className="chat-btw-exchanges">{turns.map((turn, index) => <article className="chat-btw-exchange" key={index}>
      <div className="chat-btw-question"><Markdown>{turn.question}</Markdown></div>
      <p className="chat-btw-turn-meta"><span className={`chat-btw-status is-${turn.status}`}>{label(turn.status)}</span><TurnTime ts={new Date(turn.createdAt).toISOString()} /></p>
      {turn.answer && <Markdown>{turn.answer}</Markdown>}
      {turn.error && <p className="chat-inline-error" role="alert">{turn.error}</p>}
    </article>)}</div>}
  </details>;
}

/** Thirty seconds of a pane's saved answers: reopening the dock must not read them again. */
const BTW_TTL_MS = 30_000;
const btwByPane = new Map<string, { at: number; topics: BtwTopic[] }>();

/** Saved BTW is a separate store. Its checkpoints must refresh even while the main transcript is idle. */
export function BtwPanel({ paneId, visible }: { paneId: string; visible: boolean }) {
  const t = useT();
  const { fetchPaneBtw } = useMachineApi();
  const [shown, setShown] = useBtwVisibility(useMachineId(), paneId);
  const [topics, setTopics] = useState<BtwTopic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Read when the dock appears, then only while it is open (it shows a count, so one read stays).
  useEffect(() => {
    if (!visible || !shown) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController | undefined;
    let unsupported = false;
    const read = async (): Promise<void> => {
      request = new AbortController();
      const deadline = setTimeout(() => request?.abort(), 10_000);
      try {
        const answer = await fetchPaneBtw(paneId, request.signal);
        if (controller.signal.aborted) return;
        btwByPane.set(paneId, { at: Date.now(), topics: answer.topics });
        setTopics((previous) => JSON.stringify(previous) === JSON.stringify(answer.topics) ? previous : answer.topics);
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        // Never retain another session's saved answer when the current read cannot prove its owner.
        setTopics([]);
        // a PC running a bridge without this route (upstream's published runtime) has nothing to show: no error, no more polls
        if (cause instanceof ApiError && cause.status === 404) { unsupported = true; setError(null); return; }
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        clearTimeout(deadline);
        if (!controller.signal.aborted && !unsupported && open) timer = setTimeout(read, 2000);
      }
    };
    const cached = btwByPane.get(paneId);
    const fresh = cached !== undefined && Date.now() - cached.at < BTW_TTL_MS;
    if (fresh) setTopics(cached.topics);
    if (!fresh || open) void read();
    return () => { controller.abort(); request?.abort(); clearTimeout(timer); };
  }, [paneId, visible, shown, open, fetchPaneBtw]);
  if (!shown || (topics.length === 0 && error === null)) return null;
  const running = topics.some((topic) => (topic.followUps?.at(-1) ?? topic).status === "running");
  return <section className="chat-btw" aria-label={`${t("Side conversations")} (BTW)`}>
    <div className="chat-btw-heading">
      <button type="button" className="chat-btw-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><MessageSquare aria-hidden="true" /><strong>BTW</strong><span>{t("Side conversations")}</span><span>{topics.length}</span>{running && <span className="chat-btw-status is-running">{t("Working…")}</span>}{error !== null && <span className="chat-btw-status is-error">{t("Error")}</span>}<ChevronDown className="chat-btw-caret" aria-hidden="true" /></button>
      <button type="button" className="icon-button chat-btw-close" aria-label={t("Close BTW")} title={t("Close BTW")} onClick={() => setShown(false)}><X aria-hidden="true" /></button>
    </div>
    {open && <div className="chat-btw-body">
      <p className="chat-btw-note">{t("Saved answers and follow-ups; separate from the main conversation.")}</p>
      {error !== null && <p className="chat-inline-error" role="alert">{t("Couldn't load BTW history")} · {error}</p>}
      {topics.map((topic) => <BtwTopicRow key={topic.id} topic={topic} />)}
    </div>}
  </section>;
}
