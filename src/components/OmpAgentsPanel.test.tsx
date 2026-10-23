import { afterEach, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { OmpAgentsDock } from "./OmpAgentsPanel.tsx";
import { translate } from "../lib/i18n.ts";

// the dock with its translator given: the settings provider behind useT needs a DOM this test has not
const panel = (visible: boolean) => createElement(OmpAgentsDock, { paneId: "test-pane", visible, t: (key, vars) => translate("en", key, vars) });
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
  await act(async () => { renderer = create(panel(true)); });
  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  expect(renderer!.root.findAllByProps({ className: "chat-subagent" }).map((row) => row.findByType("strong").children.join(""))).toEqual(["child-0"]);
  statuses = ["submitted"];
  await act(async () => renderer!.update(panel(false)));
  await act(async () => renderer!.update(panel(true)));
  expect(renderer!.toJSON()).toBeNull();
});
