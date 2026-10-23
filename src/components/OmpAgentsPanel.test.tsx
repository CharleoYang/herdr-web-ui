import { afterEach, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { OmpAgentsPanel } from "./OmpAgentsPanel.tsx";
import type { OmpAgent } from "../../shared/omp-agents.ts";

let renderer: ReactTestRenderer | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  fetchSpy?.mockRestore();
  if (actDescriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actDescriptor);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("shows unfinished children only and removes the panel when the last child submits", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  let statuses: OmpAgent["status"][] = ["unknown", "submitted", "failed", "cancelled", "interrupted"];
  const respond = Object.assign(async () => Response.json({ agents: statuses.map((status, i) => ({
    id: `child-${i}`, status, agent: "scout", model: "tokens/model", assignment: "Inspect", activity: "Reading source", updatedAt: null, result: "",
  })) }), { preconnect: fetch.preconnect });
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(respond);
  await act(async () => { renderer = create(createElement(OmpAgentsPanel, { paneId: "test-pane", visible: true })); });
  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  expect(renderer!.root.findAllByProps({ className: "chat-subagent" }).map((row) => row.findByType("strong").children.join(""))).toEqual(["child-0"]);
  statuses = ["submitted"];
  await act(async () => renderer!.update(createElement(OmpAgentsPanel, { paneId: "test-pane", visible: false })));
  await act(async () => renderer!.update(createElement(OmpAgentsPanel, { paneId: "test-pane", visible: true })));
  expect(renderer!.toJSON()).toBeNull();
});
