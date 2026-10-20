import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
const records = new Map<string, string>();
const storageListeners = new Set<(event: { key: string | null }) => void>();
let hook: typeof import("./btwVisibility.ts").useBtwVisibility;
let renderer: ReactTestRenderer | undefined;
let setShown: (value: boolean) => void;
let denyReads = false;
let denyWrites = false;
const key = (pane: string) => "herdr-web-ui:btw-visible:" + JSON.stringify(["local", pane]);
const receive = (key: string | null) => { for (const listener of storageListeners) listener({ key }); };

beforeAll(async () => {
  for (const name of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => { if (type === "storage") storageListeners.add(listener); },
    localStorage: {
      getItem: (key: string) => { if (denyReads) throw new Error("Storage denied"); return records.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (denyWrites) throw new Error("Quota exceeded"); records.set(key, value); },
      removeItem: (key: string) => { if (denyWrites) throw new Error("Storage denied"); records.delete(key); },
    },
  } });
  hook = (await import("./btwVisibility.ts")).useBtwVisibility;
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); }); renderer = undefined;
  denyReads = false; denyWrites = false; records.clear(); receive(null);
});
afterAll(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function Probe({ pane }: { pane: string }) {
  const [shown, update] = hook("local", pane); setShown = update;
  return createElement("span", null, shown ? "visible" : "hidden");
}
const displayed = () => renderer!.root.findByType("span").children.join("");
async function mount(pane: string) { await act(async () => { renderer = create(createElement(Probe, { pane })); }); }

it("close and reopen take effect when reads work but storage writes fail", async () => {
  denyWrites = true; await mount("quota");
  expect(displayed()).toBe("visible");
  await act(async () => setShown(false)); expect(displayed()).toBe("hidden");
  expect(records.has(key("quota"))).toBe(false);
  await act(async () => setShown(true)); expect(displayed()).toBe("visible");
});

it("retains a page-local close even if storage reads are denied but writes succeed", async () => {
  denyReads = true; await mount("read-denied");
  await act(async () => setShown(false)); expect(displayed()).toBe("hidden");
  expect(records.get(key("read-denied"))).toBe("hidden");
});

it("a remote storage update replaces local intent without changing another pane", async () => {
  await mount("remote");
  await act(async () => setShown(false)); expect(displayed()).toBe("hidden");
  records.delete(key("remote"));
  await act(async () => receive(key("other"))); expect(displayed()).toBe("hidden");
  await act(async () => receive(key("remote"))); expect(displayed()).toBe("visible");
  records.set(key("remote"), "hidden");
  await act(async () => receive(key("remote"))); expect(displayed()).toBe("hidden");
  records.clear(); await act(async () => receive(null)); expect(displayed()).toBe("visible");
});
