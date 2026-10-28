/**
 * The Agents list's rows in the order it draws them: the pinned card first, in pin order, then
 * every PC's agents in the roster's order, or in that PC's own Activity order when Settings asks
 * for it (lib/sidebarOrder.ts). A row is its PC and its pane: two PCs may reuse a pane id.
 */
import type { Machine } from "../../shared/machines.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity sorts each PC's rows by that PC's own counters */
  byActivity: boolean;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
}

/** Every PC's agent rows as the list draws them: the pinned ones first, then the rest in source order. */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  return splitPinnedRows(rows, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}

/** The workspace a group of rows runs in: a PC's workspace, since two PCs may reuse a workspace id. */
export interface AgentWorkspaceGroup {
  /** the PC and the workspace, as the list's fold key */
  key: string;
  machine: Machine;
  workspace: SidebarAgent["workspace"];
  rows: AgentRow[];
}

/**
 * The rows as the tree under their workspaces: one group per PC and workspace, in the order its
 * first row appears, each group's rows in the order it was given (the roster's, or Activity's).
 */
export function workspaceGroups(rows: readonly AgentRow[]): AgentWorkspaceGroup[] {
  const groups = new Map<string, AgentWorkspaceGroup>();
  for (const row of rows) {
    const { machine, entry } = row;
    const key = `${machine.id}\u0000${entry.workspace.workspace_id}`;
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { key, machine, workspace: entry.workspace, rows: [row] });
  }
  return [...groups.values()];
}

/** The coding agent a row runs, by herdr's own kind: never a plugin's display line for it. */
export function agentKind(row: AgentRow): string {
  return row.entry.canonicalAgent ?? row.entry.agent?.agent ?? "";
}

/** One coding agent's rows, and those rows as the tree of the workspaces they run in. */
export interface AgentKindGroup {
  key: string;
  rows: AgentRow[];
  workspaces: AgentWorkspaceGroup[];
}

/**
 * The rows as a tree of coding agents: one group per agent kind in the order its first row
 * appears, each kind's rows then grouped by workspace (one per PC) in the same order.
 */
export function agentKindGroups(rows: readonly AgentRow[]): AgentKindGroup[] {
  const groups = new Map<string, AgentRow[]>();
  for (const row of rows) {
    const kind = agentKind(row);
    const kindRows = groups.get(kind);
    if (kindRows) kindRows.push(row);
    else groups.set(kind, [row]);
  }
  return [...groups].map(([key, kindRows]) => ({ key, rows: kindRows, workspaces: workspaceGroups(kindRows) }));
}
