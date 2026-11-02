import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";

import "./OmpAgentsPanel.css";
import "./SubagentsPanel.css";

import { BackgroundAgentDetail } from "./BackgroundAgentDetail.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { clockOffsetMs, formatElapsed, taskElapsedMs } from "../lib/omoTasks.ts";
import { formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import type { OmoTask } from "../../shared/protocol.ts";

const POLL_MS = 3000;

/** A task a Claude Code or OpenCode pane started in the background as an agent, not as a command. */
const isSubagent = (task: OmoTask): boolean => task.category !== "shell";

/**
 * The pane's subagents in the chat's rail, beside the conversation: a Claude Code or OpenCode
 * session's background agents, read from `/api/pane/omo-tasks` (its own transcript, for a Claude
 * Code one). The composer's status line keeps the pane's background commands, and never both:
 * one list of subagents, in one place.
 *
 * Running ones first, oldest first, each opening what it is doing (`BackgroundAgentDetail`);
 * those that ended are one line that opens them. Read when the pane is shown and every few
 * seconds while the dock is open: a closed dock costs no transcript read.
 */
export function SubagentsPanel({ paneId, visible, expanded = true }: { paneId: string; visible: boolean; expanded?: boolean }) {
  const t = useT();
  const { fetchPaneOmoActivity } = useMachineApi();
  const machineId = useMachineId();
  const [tasks, setTasks] = useState<OmoTask[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(expanded);
  const [showEnded, setShowEnded] = useState(false);
  const [detail, setDetail] = useState<OmoTask | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** the PC's clock minus this browser's: a task's times are on the PC's */
  const [offset, setOffset] = useState(0);
  const closeDetail = useCallback(() => setDetail(null), []);

  // the pane or PC changed under the dock: a detail left open would be another pane's
  useEffect(() => { setDetail(null); setTasks(null); }, [paneId, machineId]);
  useEffect(() => { if (!open) { setShowEnded(false); } }, [open]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPaneOmoActivity(paneId);
        if (!alive) return;
        const received = Date.now();
        setTasks(next.tasks); setFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        // the clock stops with the list: a running task's time is no longer known to run on
        if (alive) setFailed(true);
      }
      if (alive && open) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [visible, open, paneId, fetchPaneOmoActivity]);

  const subagents = (tasks ?? []).filter(isSubagent);
  const running = subagents.filter((task) => task.status === "running");
  const ended = subagents.filter((task) => task.status !== "running");
  if (tasks !== null && running.length === 0 && ended.length === 0 && !failed) return null;

  const words: Record<OmoTask["status"], string> = {
    running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled"), lost: t("lost"),
  };
  const meta = (task: OmoTask): string => {
    const elapsed = taskElapsedMs(task, now + offset);
    return [
      task.status === "running" ? null : words[task.status],
      task.category, task.model,
      elapsed === null ? null : formatElapsed(elapsed),
      task.turns === null ? null : t(task.turns === 1 ? "{n} turn" : "{n} turns", { n: task.turns }),
      task.tool_calls === null ? null : t(task.tool_calls === 1 ? "{n} tool call" : "{n} tool calls", { n: task.tool_calls }),
      task.tokens === null ? null : t("{n} tokens", { n: formatTokens(task.tokens) }),
    ].filter((item) => item !== null).join(" · ");
  };
  const row = (task: OmoTask) => {
    const main = <span className="subagent-main">
      <strong className="subagent-title">{task.title}</strong>
      <span className="subagent-meta">{meta(task)}</span>
    </span>;
    if (task.status !== "running" || task.detail_kind !== "claude-subagent") return <li key={task.id} className={`subagent-row is-${task.status}`}>{main}</li>;
    // a running Claude Code subagent opens what it is doing (its own transcript); an OpenCode one has none to read
    return <li key={task.id} className="subagent-row is-openable">
      <button type="button" className="subagent-open" aria-haspopup="dialog" aria-expanded={detail?.id === task.id} onClick={(event) => { event.currentTarget.focus(); setDetail(task); }}>
        {main}
        <ChevronRight size={12} aria-hidden="true" />
      </button>
    </li>;
  };

  const summary = failed && tasks === null ? t("Couldn't load the subagents") : t("{n} running", { n: running.length });
  return <section className="chat-subagents" aria-label={t("Subagents")}>
    <button type="button" className="chat-subagents-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Users size={14} />
      <strong>{t("Subagents")}</strong><span>{running.length}</span>
      <span className="chat-subagents-summary">{summary}</span>
    </button>
    {open && <div className="chat-subagents-list">
      {failed && <p className="chat-subagents-note" role="status">{t("Couldn't refresh: this is the list as it last read")}</p>}
      {running.length === 0 && ended.length === 0 && <p className="chat-subagents-note">{t("Nothing running right now")}</p>}
      {running.length > 0 && <ul className="subagent-list">{running.map(row)}</ul>}
      {ended.length > 0 && <>
        <button type="button" className="subagent-ended-toggle" aria-expanded={showEnded} onClick={() => setShowEnded(!showEnded)}>
          {showEnded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          <span>{t("{n} recently ended", { n: ended.length })}</span>
        </button>
        <ul className="subagent-list" hidden={!showEnded}>{ended.map(row)}</ul>
      </>}
    </div>}
    {detail !== null && <BackgroundAgentDetail key={`${machineId}\0${paneId}\0${detail.id}`} paneId={paneId} task={detail} onClose={closeDetail} />}
  </section>;
}
