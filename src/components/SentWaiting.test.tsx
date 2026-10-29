import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { WAITING_HINT_MS, type WaitingSend } from "../lib/sentWaiting.ts";
import { SentWaitingList } from "./SentWaiting.tsx";

const at = Date.parse("2026-10-29T03:00:00Z");
const send: WaitingSend = { id: 1, pane: "local:p1", text: "fix the flaky test", at, after: null };

function render(now: number): string {
  setSystemTime(new Date(now));
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(SentWaitingList, { sends: [send] }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}
const textWithoutTags = (markup: string): string => markup.replace(/<[^>]*>/gu, "");

afterEach(() => { setSystemTime(); });

describe("SentWaitingList", () => {
  test("shows only the sent words, with no caption, while the agent is about to take them", () => {
    for (const now of [at, at + WAITING_HINT_MS - 1]) {
      const markup = render(now);
      expect(textWithoutTags(markup)).toBe(send.text);
      expect(markup).not.toContain("chat-sent-late");
    }
  });

  test("adds a clock beside the bubble once the turn is late, still with no caption", () => {
    const markup = render(at + WAITING_HINT_MS);
    expect(markup).toContain("chat-sent-late");
    expect(textWithoutTags(markup)).toBe(send.text);
  });
});
