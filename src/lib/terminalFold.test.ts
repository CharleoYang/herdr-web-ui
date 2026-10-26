import { describe, expect, test } from "bun:test";
import type { IBufferCell, IBufferLine } from "@xterm/xterm";
import { columnAt, contrastRatio, paletteColor, readableColor, rowHtml, webLinkAt } from "./terminalFold.ts";

interface Cell { chars: string; width?: number; fg?: number; bg?: number; bgRgb?: number; bold?: boolean; dim?: boolean; inverse?: boolean }

/** A grid row of plain cells: what rowHtml reads of xterm's buffer, palette colours only. */
function line(cells: Cell[], cols: number): IBufferLine {
  const at = (x: number): Cell => cells[x] ?? { chars: "" };
  const cell = (x: number): IBufferCell => {
    const c = at(x);
    return {
      getChars: () => c.chars,
      getWidth: () => c.width ?? 1,
      getCode: () => c.chars.codePointAt(0) ?? 0,
      isBold: () => (c.bold ? 1 : 0),
      isItalic: () => 0, isDim: () => (c.dim ? 1 : 0), isUnderline: () => 0, isBlink: () => 0, isInverse: () => (c.inverse ? 1 : 0),
      isInvisible: () => 0, isStrikethrough: () => 0, isOverline: () => 0,
      isFgDefault: () => c.fg === undefined, isBgDefault: () => c.bg === undefined && c.bgRgb === undefined,
      isFgRGB: () => false, isBgRGB: () => c.bgRgb !== undefined,
      isFgPalette: () => c.fg !== undefined, isBgPalette: () => c.bg !== undefined,
      getFgColor: () => c.fg ?? 0, getBgColor: () => c.bgRgb ?? c.bg ?? 0,
      getFgColorMode: () => 0, getBgColorMode: () => 0, isAttributeDefault: () => c.fg === undefined && c.bg === undefined && !c.bold,
    } as unknown as IBufferCell;
  };
  return { length: cols, isWrapped: false, getCell: (x: number) => (x < cols ? cell(x) : undefined), translateToString: () => "" } as unknown as IBufferLine;
}
const scratch = {} as IBufferCell;
const plain = (text: string): Cell[] => [...text].map((chars) => ({ chars }));

describe("the folded view of a mirrored grid", () => {
  test("a palette index draws as the theme's colour, xterm's own where the theme names none, then the cube and the grey ramp", () => {
    expect(paletteColor(1, { red: "#ff5555" })).toBe("#ff5555");
    expect(paletteColor(1, {})).toBe("#cc0000");
    expect(paletteColor(16, {})).toBe("#000000");
    expect(paletteColor(196, {})).toBe("#ff0000");
    expect(paletteColor(231, {})).toBe("#ffffff");
    expect(paletteColor(232, {})).toBe("#080808");
    expect(paletteColor(255, {})).toBe("#eeeeee");
  });

  test("a colour too faint on its background is lifted until it reads, as the grid's minimum contrast draws it", () => {
    const lifted = readableColor("#3465a4", "#000000", 4.5);
    expect(lifted).not.toBe("#3465a4");
    expect(readableColor(lifted, "#000000", 4.5)).toBe(lifted);
    const darkened = readableColor("#fce94f", "#ffffff", 4.5);
    expect(darkened).not.toBe("#fce94f");
    expect(readableColor(darkened, "#ffffff", 4.5)).toBe(darkened);
    expect(readableColor("#eeeeec", "#000000", 4.5)).toBe("#eeeeec");
    expect(readableColor("#3465a4", "#000000", 1)).toBe("#3465a4");
    expect(readableColor("rgb(1, 2, 3)", "#000000", 4.5)).toBe("rgb(1, 2, 3)");
  });

  test("a row is its runs of cells drawn alike, without the blank cells herdr pads it with", () => {
    const cells: Cell[] = [{ chars: "a", fg: 1 }, { chars: "b", fg: 1 }, { chars: " " }, { chars: "가", width: 2 }, { chars: "", width: 0 }, ...plain("<&>   ")];
    expect(rowHtml(line(cells, 12), 12, { red: "#ff5555" }, scratch)).toBe('<span style="color:#ff5555;">ab</span> 가&lt;&amp;&gt;');
  });

  test("a row that draws only a background keeps it, and an empty row is empty", () => {
    expect(rowHtml(line([{ chars: " ", bg: 2 }], 4), 4, { green: "#50fa7b" }, scratch)).toBe('<span style="background:#50fa7b;"> </span>');
    expect(rowHtml(line([], 4), 4, {}, scratch)).toBe("");
  });

  test("dim text fades its colour, not its background", () => {
    expect(rowHtml(line([{ chars: "d", fg: 2, bg: 0, dim: true }], 1), 1, {}, scratch))
      .toBe('<span style="color:color-mix(in srgb, #4e9a06 50%, transparent);background:#2e3436;">d</span>');
  });

  test("a tap on a folded row finds the http(s) address it is on, without the punctuation after it", () => {
    const text = " see https://example.com/a?b=1). or http://x.y";
    expect(webLinkAt(text, text.indexOf("example"))).toEqual({ url: "https://example.com/a?b=1", start: 5, end: 30 });
    expect(webLinkAt(text, 30)).toBeNull();
    expect(webLinkAt(text, 1)).toBeNull();
    expect(webLinkAt(text, text.length - 1)?.url).toBe("http://x.y");
    const wiki = "(see https://en.wikipedia.org/wiki/Function_(mathematics)).";
    expect(webLinkAt(wiki, 10)?.url).toBe("https://en.wikipedia.org/wiki/Function_(mathematics)");
  });

  test("a folded row's character is found in its grid column, past wide glyphs and the cells they cover", () => {
    const row = line([{ chars: "가", width: 2 }, { chars: "", width: 0 }, { chars: "" }, ...plain("ab")], 6);
    expect([0, 1, 2, 3].map((offset) => columnAt(row, 6, offset, scratch))).toEqual([0, 2, 3, 4]);
    expect(columnAt(row, 6, 9, scratch)).toBe(-1);
  });

  test("a colour that cannot reach the contrast one way reaches it the other", () => {
    const grey = readableColor("#aaaaaa", "#aaaaaa", 4.5);
    expect(contrastRatio(grey, "#aaaaaa")!).toBeGreaterThanOrEqual(4.5);
  });

  test("a default foreground on a background of the program's own colour still reads", () => {
    const html = rowHtml(line([{ chars: "x", bgRgb: 0xd8d0c3 }], 1), 1, { foreground: "#d8d0c3", background: "#1b1b1b" }, scratch, 4.5);
    const color = /color:(#[0-9a-f]{6});/.exec(html)?.[1];
    expect(color).toBeDefined();
    expect(contrastRatio(color!, "#d8d0c3")!).toBeGreaterThanOrEqual(4.5);
  });

  test("inverse swaps the colours before bold brightens the foreground, as xterm draws them", () => {
    expect(rowHtml(line([{ chars: "x", fg: 1, bg: 4, bold: true, inverse: true }], 1), 1, {}, scratch))
      .toBe('<span style="color:#729fcf;background:#cc0000;font-weight:bold;">x</span>');
    expect(rowHtml(line([{ chars: "x", inverse: true }], 1), 1, { foreground: "#eeeeee", background: "#111111" }, scratch))
      .toBe('<span style="color:#111111;background:#eeeeee;">x</span>');
  });

  test("bold text of the first eight colours draws in their bright forms", () => {
    expect(rowHtml(line([{ chars: "x", fg: 1, bold: true }], 1), 1, {}, scratch)).toBe('<span style="color:#ef2929;font-weight:bold;">x</span>');
  });
});
