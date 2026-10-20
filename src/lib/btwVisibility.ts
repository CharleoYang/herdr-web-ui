import { useSyncExternalStore } from "react";

const PREFIX = "herdr-web-ui:btw-visible:";
const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();
const notify = (): void => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === null) memory.clear();
  else if (event.key.startsWith(PREFIX)) memory.delete(event.key);
  else return;
  notify();
});

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
