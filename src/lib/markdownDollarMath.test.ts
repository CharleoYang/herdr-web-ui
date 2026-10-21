import { expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "./markdown.ts";

test("Ask may opt in to dollar math without changing ordinary chat or code", () => {
  expect(parseInline("$x_i^2$", true, 0, true)).toEqual([{ type: "math", value: "x_i^2" }]);
  expect(parseInline("$x_i^2$")).not.toContainEqual({ type: "math", value: "x_i^2" });
  expect(parseInline("`$x_i$`", true, 0, true)).toEqual([{ type: "code", value: "$x_i$" }]);
  expect(parseMarkdown("```sh\necho '$x_i$'\n```", 0, false, true)).toEqual([{ type: "code", language: "sh", value: "echo '$x_i$'" }]);
  for (const text of ["Costs $5 or $10", "\\$x$", "$ unmatched", "$$x$$"]) {
    expect(parseInline(text, true, 0, true).filter(node => node.type === "math")).toEqual([]);
  }
});

test("Ask math reaches emphasis, tables, nested lists and quotes through the existing parser", () => {
  expect(parseInline("**$2^3$**", true, 0, true)).toEqual([{ type: "strong", children: [{ type: "math", value: "2^3" }] }]);
  expect(parseMarkdown("| x | y |\n|---|---|\n| $2^3$ | 8 |", 0, false, true)).toEqual([
    { type: "table", header: [[{ type: "text", value: "x" }], [{ type: "text", value: "y" }]], rows: [[[{ type: "math", value: "2^3" }], [{ type: "text", value: "8" }]]] },
  ]);
  expect(parseMarkdown("> $x_i$", 0, false, true)).toEqual([{ type: "blockquote", blocks: [{ type: "paragraph", lines: [[{ type: "math", value: "x_i" }]] }] }]);
  const list = parseMarkdown("- Outer\n  - $2^3$", 0, false, true)[0];
  expect(list?.type).toBe("list");
  if (list?.type === "list") expect(list.items[0]?.blocks).toEqual([{ type: "list", ordered: false, items: [{ content: [{ type: "math", value: "2^3" }] }] }]);
});
