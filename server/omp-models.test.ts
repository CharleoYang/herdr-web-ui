import { describe, expect, test } from "bun:test";
import { ompSwitchCommand, parseOmpModels } from "./omp-models.ts";

describe("omp model switch", () => {
  test("keeps chat models whose selector is provider/id", () => {
    const models = parseOmpModels(JSON.stringify({
      models: [
        { provider: "xai-oauth", id: "grok-4.7", selector: "xai-oauth/grok-4.7", name: "Grok 4.7", kind: "chat" },
        { provider: "tokens", id: "gpt-5.6-sol", selector: "tokens/gpt-5.6-sol", name: "GPT-5.6-Sol", kind: "chat" },
        { provider: "local", id: "embed", selector: "local/embed", name: "Embed", kind: "embedding" },
        { provider: "bad", id: "x", selector: "not-the-same", name: "Nope", kind: "chat" },
      ],
    }));
    expect(models.map((model) => model.selector)).toEqual(["tokens/gpt-5.6-sol", "xai-oauth/grok-4.7"]);
  });

  test("refuses a selector that is not a single slash command argument", () => {
    expect(ompSwitchCommand("xai-oauth/grok-4.7")).toBe("/switch xai-oauth/grok-4.7");
    expect(ompSwitchCommand("grok-4.7")).toBeNull();
    expect(ompSwitchCommand("xai-oauth/grok-4.7;rm")).toBeNull();
    expect(ompSwitchCommand("a/b\n/switch")).toBeNull();
  });
});
