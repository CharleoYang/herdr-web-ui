import { describe, expect, it } from "bun:test";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/machines.json";
import { agentKindGroups, agentRoster, workspaceGroups } from "./agentRoster.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

const template = fixture.machines[0]!.snapshot as SessionSnapshot;
const templatePane = template.panes.find((pane) => pane.agent) ?? template.panes[0]!;
const workspace = template.workspaces[0]!;

/** a PC whose agents are the named panes, in that order, each with its own status */
function machine(id: string, state: MachineState, panes: [id: string, status: AgentStatus][]): Machine {
  const snapshot: SessionSnapshot = {
    ...template,
    panes: panes.map(([pane_id, agent_status]): HerdrPane => ({ ...templatePane, pane_id, agent_status, workspace_id: workspace.workspace_id, agent: "claude", background_wait: undefined })),
    agents: panes.map(([pane_id, agent_status], index) => ({ ...template.agents[0]!, pane_id, agent_status, agent: "claude", state_change_seq: index + 1 })),
  };
  return { id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot };
}

describe("agent roster", () => {
  it("keeps the pinned card first in pin order and each PC's rows in its own Activity order", () => {
    const machines = [machine("local", "connected", [["a", "done"], ["b", "blocked"], ["c", "working"]]), machine("remote", "connected", [["d", "idle"], ["e", "blocked"]])];
    const seqs = new Map<string, ReadonlyMap<string, number>>([["local", new Map([["a", 1], ["b", 2], ["c", 3]])], ["remote", new Map([["d", 9], ["e", 1]])]]);
    const split = agentRoster(machines, { byActivity: true, seqs: (id) => seqs.get(id) ?? new Map(), pinned: [sidebarPinKey("remote", "d"), sidebarPinKey("local", "c")] });
    const key = ({ machine, entry }: { machine: Machine; entry: { pane: HerdrPane } }) => `${machine.id}/${entry.pane.pane_id}`;
    expect(split.pinned.map(key)).toEqual(["remote/d", "local/c"]);
    // blocked first, then the latest change, within each PC; the PCs keep their order
    expect(split.rest.map(key)).toEqual(["local/b", "local/a", "remote/e"]);
  });

  it("gathers rows under their own workspace, in first-appearance order, keeping the rows' order", () => {
    // Two workspaces on one PC; Activity interleaves them (b newest, c, then a).
    const entries: [pane: string, workspace: string, seq: number][] = [["a", "wa", 1], ["b", "wb", 3], ["c", "wa", 2]];
    const snapshot: SessionSnapshot = {
      ...template,
      workspaces: [
        { ...workspace, workspace_id: "wa", label: "alpha", number: 1, active_tab_id: "wa:t1" },
        { ...workspace, workspace_id: "wb", label: "beta", number: 2, active_tab_id: "wb:t1" },
      ],
      tabs: entries.map(([, id]) => ({ tab_id: `${id}:t1`, workspace_id: id, label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" })),
      panes: entries.map(([pane_id, id]) => ({ ...templatePane, pane_id, workspace_id: id, tab_id: `${id}:t1`, agent: "claude", agent_status: "idle" })),
      agents: entries.map(([pane_id, id, state_change_seq]) => ({ ...template.agents[0]!, pane_id, workspace_id: id, tab_id: `${id}:t1`, agent: "claude", agent_status: "idle", state_change_seq })),
    };
    const pc: Machine = { id: "local", name: "local", kind: "local", enabled: true, state: "connected", error: null, snapshot };
    const seqs = new Map(entries.map(([pane_id, , seq]) => [pane_id, seq]));
    const split = agentRoster([pc], { byActivity: true, seqs: () => seqs, pinned: [] });
    const groups = workspaceGroups(split.rest);
    expect(groups.map((group) => group.workspace.label)).toEqual(["beta", "alpha"]);
    expect(groups.map((group) => group.rows.map(({ entry }) => entry.pane.pane_id))).toEqual([["b"], ["c", "a"]]);
    expect(groups.map((group) => group.key)).toEqual([`local\u0000wb`, `local\u0000wa`]);
  });

  it("groups by coding agent first, then by the rows' workspaces", () => {
    // Two kinds over two workspaces, in herdr's order: claude in wa (a, c) and wb (d), codex in wb (b).
    const entries: [pane: string, workspace: string, agent: string][] = [["a", "wa", "claude"], ["b", "wb", "codex"], ["c", "wa", "claude"], ["d", "wb", "claude"]];
    const snapshot: SessionSnapshot = {
      ...template,
      workspaces: [
        { ...workspace, workspace_id: "wa", label: "alpha", number: 1, active_tab_id: "wa:t1" },
        { ...workspace, workspace_id: "wb", label: "beta", number: 2, active_tab_id: "wb:t1" },
      ],
      tabs: entries.map(([, id]) => ({ tab_id: `${id}:t1`, workspace_id: id, label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" })),
      panes: entries.map(([pane_id, id, agent]) => ({ ...templatePane, pane_id, workspace_id: id, tab_id: `${id}:t1`, agent, agent_status: "idle" })),
      agents: entries.map(([pane_id, id, agent]) => ({ ...template.agents[0]!, pane_id, workspace_id: id, tab_id: `${id}:t1`, agent, agent_status: "idle" })),
    };
    const pc: Machine = { id: "local", name: "local", kind: "local", enabled: true, state: "connected", error: null, snapshot };
    const split = agentRoster([pc], { byActivity: false, seqs: () => new Map(), pinned: [] });
    const kinds = agentKindGroups(split.rest);
    expect(kinds.map((kind) => kind.key)).toEqual(["claude", "codex"]);
    expect(kinds.map((kind) => kind.rows.map(({ entry }) => entry.pane.pane_id))).toEqual([["a", "c", "d"], ["b"]]);
    // each kind's rows are then a tree of their workspaces, in first-appearance order
    expect(kinds[0]!.workspaces.map((group) => group.workspace.label)).toEqual(["alpha", "beta"]);
    expect(kinds[0]!.workspaces.map((group) => group.rows.map(({ entry }) => entry.pane.pane_id))).toEqual([["a", "c"], ["d"]]);
    expect(kinds[1]!.workspaces.map((group) => group.workspace.label)).toEqual(["beta"]);
  });
});
