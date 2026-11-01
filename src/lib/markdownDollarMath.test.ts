import { expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../../shared/markdown.ts";

test("Ask shares upstream dollar math with ordinary chat while code stays literal", () => {
  expect(parseInline("$x_i^2$")).toEqual([{ type: "math", value: "x_i^2", dollar: true }]);
  expect(parseInline("`$x_i$`")).toEqual([{ type: "code", value: "$x_i$" }]);
  expect(parseMarkdown("```sh\necho '$x_i$'\n```")).toEqual([{ type: "code", language: "sh", value: "echo '$x_i$'" }]);
  for (const text of ["Costs $5 or $10", "\\$x$", "$ unmatched", "$$x$$"]) {
    expect(parseInline(text).filter(node => node.type === "math")).toEqual([]);
  }
});

test("Ask math reaches emphasis, tables, nested lists and quotes through the existing parser", () => {
  expect(parseInline("**$2^3$**")).toEqual([{ type: "strong", children: [{ type: "math", value: "2^3", dollar: true }] }]);
  expect(parseMarkdown("| x | y |\n|---|---|\n| $2^3$ | 8 |")).toEqual([
    { type: "table", header: [[{ type: "text", value: "x" }], [{ type: "text", value: "y" }]], rows: [[[{ type: "math", value: "2^3", dollar: true }], [{ type: "text", value: "8" }]]] },
  ]);
  expect(parseMarkdown("> $x_i$")).toEqual([{ type: "blockquote", blocks: [{ type: "paragraph", lines: [[{ type: "math", value: "x_i", dollar: true }]] }] }]);
  const list = parseMarkdown("- Outer\n  - $2^3$")[0];
  expect(list?.type).toBe("list");
  if (list?.type === "list") expect(list.items[0]?.blocks).toEqual([{ type: "list", ordered: false, items: [{ content: [{ type: "math", value: "2^3", dollar: true }] }] }]);
});
