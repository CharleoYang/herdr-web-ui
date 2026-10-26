import { useSyncExternalStore } from "react";

const PREFIX = "ovis:btw-visible:";
const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();
const notify = (): void => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  bindStorage();
  return () => { listeners.delete(listener); };
}

const onStorage = (event: Event): void => {
  const key = (event as StorageEvent).key;
  if (key === null) memory.clear();
  else if (key.startsWith(PREFIX)) memory.delete(key);
  else return;
  notify();
};

/** The window this module listens on: a page keeps one, a test file may install its own. */
let bound: (Window & typeof globalThis) | null = null;
function bindStorage(): void {
  if (typeof window === "undefined" || bound === window) return;
  bound?.removeEventListener("storage", onStorage);
  window.addEventListener("storage", onStorage);
  bound = window;
}

/** Local to this browser and pane. Hiding never deletes the agent's saved answers. */
export function useBtwVisibility(machineId: string, paneId: string | null) {
  const key = paneId === null ? null : PREFIX + JSON.stringify([machineId, paneId]);
  const shown = useSyncExternalStore(subscribe, () => {
    if (key === null) return true;
    if (memory.has(key)) return memory.get(key)!;
    try { return window.localStorage.getItem(key) !== "hidden"; }
    catch { return memory.get(key) ?? true; }
  }, () => true);
  const setShown = (value: boolean): void => {
    if (key === null) return;
    memory.set(key, value);
    try {
      if (value) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, "hidden");
    } catch { /* denied storage: remember for this page's lifetime */ }
    notify();
  };
  return [shown, setShown] as const;
}
