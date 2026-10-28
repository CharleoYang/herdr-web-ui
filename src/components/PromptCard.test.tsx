import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PromptCard } from "./PromptCard.tsx";

const goal: InteractivePrompt = {
  id: "g", agent: "claude", kind: "menu", title: "Goal active", question: "the file hello.txt exists", body: "running 25s · 0 tokens",
  options: [{ label: "Close", description: null }], multi_select: false, custom_option_index: null,
  own_text: { title: { key: "Goal active" }, labels: { 0: { key: "Close" } } },
};

const render = (prompt: InteractivePrompt, languages: string[], screenWords: string | null = null): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PromptCard, {
      paneId: "w1:p1", prompt, onPromptChanged: () => {}, onAnswered: () => {}, screenWords,
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a prompt card's own words", () => {
  it("shows the words the bridge wrote in the reader's language, and the agent's as written (#1482)", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const html = render(goal, [language]);
      expect(html).toContain(`<h2>${translate(language, "Goal active")}</h2>`);
      expect(html).toContain(translate(language, "Close"));
      expect(html).not.toContain("<h2>Goal active</h2>");
      expect(html).toContain("the file hello.txt exists");
      expect(html).toContain("running 25s · 0 tokens");
    }
  });

  it("shows an older bridge's card, which names no words of its own, as it came", () => {
    const { own_text: _, ...older } = goal;
    expect(render(older, ["ko"])).toContain("<h2>Goal active</h2>");
  });
});

describe("Claude's words over its question, read off the screen (#2088)", () => {
  const asked: InteractivePrompt = {
    id: "q", agent: "claude", kind: "question", title: "Fix", question: "Which fix do you want?", body: null,
    options: [{ label: "Patch", description: null }, { label: "Rewrite", description: null }], multi_select: false, custom_option_index: null,
  };

  it("shows them over the question, saying where they came from in the reader's language", () => {
    const html = render(asked, ["ko"], "There are two ways to fix it.\n\nPatch adds the newline.");
    expect(html).toContain("There are two ways to fix it.\n\nPatch adds the newline.");
    expect(html).toContain(translate("ko", "From the terminal, until the agent saves this turn"));
    expect(html.indexOf("There are two ways")).toBeLessThan(html.indexOf("Which fix do you want?"));
  });

  it("shows no words and no caption without them", () => {
    expect(render(asked, ["en"])).not.toContain("prompt-card-words");
  });
});
