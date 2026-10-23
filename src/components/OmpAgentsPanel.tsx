import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import type { OmpAgent } from "../../shared/omp-agents.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { Markdown } from "./Markdown.tsx";
import "./OmpAgentsPanel.css";

const labels: Record<OmpAgent["status"], string> = {
  unknown: "No completion recorded", submitted: "Submitted", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted",
};

function OmpAgentRow({ agent }: { agent: OmpAgent }) {
  const [open, setOpen] = useState(false);
  return <details className="chat-subagent" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <strong>{agent.id}</strong><span className={`chat-subagent-status is-${agent.status}`}>{labels[agent.status]}</span>
      <span className="chat-subagent-model">{agent.model ?? "Model not recorded"}</span>
      {agent.activity && <span className="chat-subagent-activity">{agent.activity}</span>}
    </summary>
    {open && <div className="chat-subagent-body">
      {agent.agent && <p>Agent: {agent.agent}</p>}
      {agent.updatedAt && <p>Last checkpoint: <time dateTime={agent.updatedAt}>{new Date(agent.updatedAt).toLocaleString()}</time></p>}
      {agent.assignment && <details><summary>Assignment</summary><Markdown>{agent.assignment}</Markdown>{agent.assignment.length >= 24_000 && <p>Showing the first 24,000 characters.</p>}</details>}
      {agent.result ? <><h4>{agent.status === "failed" ? "Error" : "Submitted result"}</h4><Markdown>{agent.result}</Markdown>{agent.result.length >= 24_000 && <p>Showing the first 24,000 characters.</p>}</> : <p>No submitted result recorded.</p>}
    </div>}
  </details>;
}

/** A journal checkpoint, not a process monitor. Kept outside the virtual transcript. */
export function OmpAgentsPanel({ paneId, visible }: { paneId: string; visible: boolean }) {
  const { fetchPaneOmpAgents } = useMachineApi();
  const [agents, setAgents] = useState<OmpAgent[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await fetchPaneOmpAgents(paneId, controller.signal);
        if (!controller.signal.aborted) { setAgents(result.agents.filter((agent) => agent.status === "unknown")); setError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [paneId, visible, fetchPaneOmpAgents]);

  if (!agents.length && !error) return null;
  return <section className="chat-subagents" aria-label="OMP subagents">
    <button type="button" className="chat-subagents-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Users size={14} />
      <strong>Subagents</strong><span>{agents.length}</span>
      <span className="chat-subagents-summary">{error ? "Update unavailable" : `${agents.length} unfinished`}</span>
    </button>
    {open && <div className="chat-subagents-list">
      <p className="chat-subagents-note">Unfinished checkpoints · not a live process status</p>
      {error && <p role="status">Could not refresh subagents: {error}</p>}
      {agents.map((agent) => <OmpAgentRow key={agent.id} agent={agent} />)}
    </div>}
  </section>;
}
