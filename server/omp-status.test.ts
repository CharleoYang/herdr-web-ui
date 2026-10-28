import { describe, expect, it } from "bun:test";

import { ompStatusContext } from "./omp-status.ts";

// a pane's bottom rows, as `pane.read?format=text` answers them
const bar = (size: string, percent: string): string => [
  "",
  " ⠋ 46s · ◒ deepseek-flash · 📁 ~/coding_agent · ◫ " + percent + "/" + size + " ⟲ · $105.66 (+30.57) ↑ + 👁 1.68   🖥️ WUI: Review repo chang…",
  "",
].join("\n");

describe("ompStatusContext", () => {
  it("reads the percent and the window omp's bar states", () => {
    expect(ompStatusContext(bar("1M", "48.1%"))).toEqual({ used: 481_000, window: 1_000_000 });
    expect(ompStatusContext(bar("200k", "0.4%"))).toEqual({ used: 800, window: 200_000 });
    expect(ompStatusContext(bar("1M", "100%"))).toEqual({ used: 1_000_000, window: 1_000_000 });
  });

  it("takes the last bar: a page of scrollback may quote an older one", () => {
    const screen = [bar("200k", "9%"), "output", bar("1M", "12.5%")].join("\n");
    expect(ompStatusContext(screen)).toEqual({ used: 125_000, window: 1_000_000 });
  });

  it("says nothing where omp drew no bar", () => {
    expect(ompStatusContext("")).toBeNull();
    expect(ompStatusContext("plain output\nwith no status bar")).toBeNull();
    // a dialog over the bar, and a bar whose percent is not a number this reader guesses
    expect(ompStatusContext("◫ --/1M")).toBeNull();
  });
});
