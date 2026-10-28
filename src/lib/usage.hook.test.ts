import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useUsage } from "./usage.ts";

let renderer: ReactTestRenderer | null = null;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let restoreGlobals: () => void;
function Probe({ enabled, localOnly }: { enabled: boolean; localOnly: boolean }) {
  useUsage(enabled, localOnly);
  return null;
}
beforeEach(() => {
  const saved = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  restoreGlobals = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ providers: [] }), { preconnect: globalThis.fetch.preconnect }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  fetchSpy.mockRestore();
  restoreGlobals();
});

it("keeps local-only polling and refresh events off the full usage endpoint, while enabled reporting still works", async () => {
  await act(async () => { renderer = create(createElement(Probe, { enabled: true, localOnly: true })); });
  await act(async () => { window.dispatchEvent(new Event("herdr-usage-changed")); });
  expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(fetchSpy.mock.calls.every(([url]) => String(url) === "/api/usage?scope=claude-local")).toBe(true);
  fetchSpy.mockClear();
  await act(async () => { renderer!.update(createElement(Probe, { enabled: true, localOnly: false })); });
  expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(["/api/usage"]);
  fetchSpy.mockClear();
  await act(async () => { renderer!.update(createElement(Probe, { enabled: false, localOnly: false })); });
  await act(async () => { window.dispatchEvent(new Event("herdr-usage-changed")); });
  expect(fetchSpy).not.toHaveBeenCalled();
});
