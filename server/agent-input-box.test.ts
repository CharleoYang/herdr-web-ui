import { describe, expect, it } from "bun:test";

import { editorBoxText } from "./agent-input-box.ts";

const RULE = "────────────────────────────────────────────────────────";
// a real omp pane's bottom, as `pane.read?format=text` answers it: the editor between two rules,
// the status bar under them, blanks where nothing is drawn
const statusBar = " ⠋ 46s · ◒ deepseek-flash · 📁 ~/coding_agent · ◫ 48.1%/1M ⟲ · $105.66 (+30.57)";

describe("editorBoxText", () => {
  it("reads an empty editor as empty", () => {
    expect(editorBoxText([RULE, "", RULE, statusBar, ""].join("\n"))).toBe("");
    expect(editorBoxText([RULE, "   ", RULE, statusBar].join("\n"))).toBe("");
  });

  it("reads what the reader typed, wrapped rows included", () => {
    const typed = "还有个问题是 claude code 的消息其实已经发送上去了，只不过它有等 next turn 的过程\n第二行";
    expect(editorBoxText([RULE, ` ${typed.split("\n")[0]}`, ` ${typed.split("\n")[1]}`, RULE, statusBar].join("\n")))
      .toBe(typed);
  });

  it("takes the last pair of rules: earlier rules belong to the transcript", () => {
    const screen = [RULE, "earlier output", RULE, "", "more output", RULE, "a draft here", RULE, statusBar].join("\n");
    expect(editorBoxText(screen)).toBe("a draft here");
  });

  it("says nothing for a screen it cannot read as that editor", () => {
    // no rules at all, one rule, and a panel that took the editor's place
    expect(editorBoxText(["no rules here", "plain output"].join("\n"))).toBeNull();
    expect(editorBoxText([RULE, statusBar].join("\n"))).toBeNull();
    expect(editorBoxText([RULE, ...Array.from({ length: 20 }, (_, index) => `row ${index}`), RULE].join("\n"))).toBeNull();
  });
});
