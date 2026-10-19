import { useEffect, useState } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import type { BtwTopic, BtwTurn } from "../../shared/omp-btw.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";
import { TurnTime } from "./TurnTime.tsx";
import "./BtwPanel.css";

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

/** Saved BTW is a separate store. Its checkpoints must refresh even while the main transcript is idle. */
export function BtwPanel({ paneId, visible }: { paneId: string; visible: boolean }) {
  const t = useT();
  const { fetchPaneBtw } = useMachineApi();
  const [topics, setTopics] = useState<BtwTopic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async (): Promise<void> => {
      try {
        const answer = await fetchPaneBtw(paneId, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
        if (controller.signal.aborted) return;
        setTopics((previous) => JSON.stringify(previous) === JSON.stringify(answer.topics) ? previous : answer.topics);
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        // Never retain another session's saved answer when the current read cannot prove its owner.
        setTopics([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 2000);
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [paneId, visible, fetchPaneBtw]);
  if (topics.length === 0 && error === null) return null;
  const running = topics.some((topic) => (topic.followUps?.at(-1) ?? topic).status === "running");
  return <details className="chat-btw" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><MessageSquare aria-hidden="true" /><strong>BTW</strong><span>{t("Side conversations")}</span><span>{topics.length}</span>{running && <span className="chat-btw-status is-running">{t("Working…")}</span>}{error !== null && <span className="chat-btw-status is-error">{t("Error")}</span>}<ChevronDown className="chat-btw-caret" aria-hidden="true" /></summary>
    {open && <div className="chat-btw-body">
      <p className="chat-btw-note">{t("Saved answers and follow-ups; separate from the main conversation.")}</p>
      {error !== null && <p className="chat-inline-error" role="alert">{t("Couldn't load BTW history")} · {error}</p>}
      {topics.map((topic) => <BtwTopicRow key={topic.id} topic={topic} />)}
    </div>}
  </details>;
}
