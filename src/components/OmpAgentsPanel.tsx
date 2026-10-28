import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import type { OmpAgent } from "../../shared/omp-agents.ts";
import { ApiError } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { Markdown } from "./Markdown.tsx";
import "./OmpAgentsPanel.css";

function statusLabel(t: Translate, status: OmpAgent["status"]): string {
  switch (status) {
    case "submitted": return t("Submitted");
    case "failed": return t("Failed");
    case "cancelled": return t("Cancelled");
    case "interrupted": return t("Interrupted");
    default: return t("No completion recorded");
  }
}

function OmpAgentRow({ agent, t }: { agent: OmpAgent; t: Translate }) {
  const [open, setOpen] = useState(false);
  const clipped = <p>{t("Showing the first {count} characters.", { count: "24,000" })}</p>;
  return <details className="chat-subagent" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <strong>{agent.id}</strong><span className={`chat-subagent-status is-${agent.status}`}>{statusLabel(t, agent.status)}</span>
      <span className="chat-subagent-model">{agent.model ?? t("Model not recorded")}</span>
      {agent.activity && <span className="chat-subagent-activity">{agent.activity}</span>}
    </summary>
    {open && <div className="chat-subagent-body">
      {agent.agent && <p>{t("Agent: {agent}", { agent: agent.agent })}</p>}
      {agent.updatedAt && <p>{t("Last checkpoint")}: <time dateTime={agent.updatedAt}>{new Date(agent.updatedAt).toLocaleString()}</time></p>}
      {agent.assignment && <details><summary>{t("Assignment")}</summary><Markdown>{agent.assignment}</Markdown>{agent.assignment.length >= 24_000 && clipped}</details>}
      {agent.result ? <><h4>{agent.status === "failed" ? t("Error") : t("Submitted result")}</h4><Markdown>{agent.result}</Markdown>{agent.result.length >= 24_000 && clipped}</> : <p>{t("No submitted result recorded.")}</p>}
    </div>}
  </details>;
}

/** Thirty seconds of a pane's subagents: reopening the dock must not read the transcripts again. */
const OMP_AGENTS_TTL_MS = 30_000;
const ompAgentsByPane = new Map<string, { at: number; agents: OmpAgent[] }>();

/** A journal checkpoint, not a process monitor. Kept outside the virtual transcript. */
export function OmpAgentsPanel(props: { paneId: string; visible: boolean; expanded?: boolean }) {
  return <OmpAgentsDock {...props} t={useT()} />;
}

/** The dock with its translator given, so a test renders it without the settings provider's DOM. */
export function OmpAgentsDock({ paneId, visible, expanded = false, t }: { paneId: string; visible: boolean; expanded?: boolean; t: Translate }) {
  const { fetchPaneOmpAgents } = useMachineApi();
  const [agents, setAgents] = useState<OmpAgent[]>([]);
  const [open, setOpen] = useState(expanded);
  const [error, setError] = useState<string | null>(null);
  // Read when the pane appears, then only while the dock is open: a closed dock kept the
  // child transcripts re-read every three seconds for a count nobody was looking at.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsupported = false;
    const read = async () => {
      try {
        const result = await fetchPaneOmpAgents(paneId, controller.signal);
        if (controller.signal.aborted) return;
        const unfinished = result.agents.filter((agent) => agent.status === "unknown");
        ompAgentsByPane.set(paneId, { at: Date.now(), agents: unfinished });
        setAgents(unfinished); setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        // a PC running a bridge without this route (upstream's published runtime) has nothing to show: no error, no more polls
        if (cause instanceof ApiError && cause.status === 404) { unsupported = true; setAgents([]); setError(null); return; }
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted && !unsupported && open) timer = setTimeout(read, 3000);
      }
    };
    const cached = ompAgentsByPane.get(paneId);
    const fresh = cached !== undefined && Date.now() - cached.at < OMP_AGENTS_TTL_MS;
    if (fresh) setAgents(cached.agents);
    if (!fresh || open) void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [paneId, visible, open, fetchPaneOmpAgents]);

  if (!agents.length && !error) return null;
  return <section className="chat-subagents" aria-label={t("OMP subagents")}>
    <button type="button" className="chat-subagents-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Users size={14} />
      <strong>{t("Subagents")}</strong><span>{agents.length}</span>
      <span className="chat-subagents-summary">{error ? t("Update unavailable") : t("{n} unfinished", { n: agents.length })}</span>
    </button>
    {open && <div className="chat-subagents-list">
      <p className="chat-subagents-note">{t("Unfinished checkpoints · not a live process status")}</p>
      {error && <p role="status">{t("Could not refresh subagents: {error}", { error })}</p>}
      {agents.map((agent) => <OmpAgentRow key={agent.id} agent={agent} t={t} />)}
    </div>}
  </section>;
}
