import { expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as settings from "../lib/settings.ts";
import { Composer } from "./Composer.tsx";
import { submitRefusal } from "../lib/compose.ts";

it("submit_partial displays an informational notice without a Send anyway action", async () => {
  const originals = new Map(["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  const settingsSpy = spyOn(settings, "useSettings").mockReturnValue({ settings: { ...settings.DEFAULT_SETTINGS, showUsage: false, voiceInput: "off" }, resolvedLanguage: "en" } as ReturnType<typeof settings.useSettings>);
  let renderer!: ReactTestRenderer;
  let submissions = 0;
  try {
    await act(async () => { renderer = create(createElement(Composer, { connected: true, paneId: "info-notice-test", agent: "claude", autoFocus: false, restored: "keep this message", onSend: () => { submissions++; return submitRefusal("submit_partial", "not confirmed"); }, onAbort: () => {}, onUploadImage: async () => { throw new Error("unexpected upload"); } })); });
    await act(async () => { renderer.root.findByProps({ className: "composer-action composer-send" }).props.onClick(); });
    const note = renderer.root.findByProps({ className: "composer-note composer-note-info" });
    expect(note.props.role).toBe("status");
    expect(note.findAllByType("button")).toHaveLength(0);
    expect(renderer.root.findByProps({ className: "composer-text" }).props.value).toBe("keep this message");
    expect(submissions).toBe(1);
  } finally {
    if (renderer) act(() => renderer.unmount());
    settingsSpy.mockRestore();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
