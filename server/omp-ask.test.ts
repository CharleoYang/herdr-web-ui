import { expect, test } from "bun:test";
import type { ConversationTurn } from "../shared/protocol.ts";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";
import { enrichOmpAsk } from "./omp-ask.ts";

const question = "**Which Markdown deployment preview should we inspect?**\n\n- **Preview** first\n- Keep `--dry-run`\n\n```sh\nbun run build\n```";
const asked = { question, header: "Deployment", recommended: 0, options: [
  { label: "Preview", description: "**Read** `output`", preview: "| x | y |\n|---|---|\n| a | 1 |" },
  { label: "Execute", description: "*Check* first", preview: "> Keep **rollback**" },
] };
const screen = (multi = false) => `╭─ Ask ──────────────────────────────────────────╮
│ Which Markdown deployment preview should we inspect? … │
├────────────────────────────────────────────────┤
│ ❯ ${multi ? "☐" : "○"} Preview (Recommended)             │
│   ${multi ? "☐" : "○"} Execute                           │
│   ○ Other (type your own)                      │
├────────────────────────────────────────────────┤
│ ${multi ? "␣ toggle · ⏎ submit" : "⏎ select · n note"} · ↑/↓ move · ⎋ cancel │
╰────────────────────────────────────────────────╯`;
const turns = (questions: unknown[] = [asked], output = ""): ConversationTurn[] => [{ role: "assistant", ts: "2026-10-21T09:24:35Z", parts: [
  { kind: "tool", name: "ask", input: JSON.stringify({ questions }), summary: "Choose", output },
] }];

test("restores full Markdown and previews without changing native single-choice/custom answer keys", () => {
  const native = parseInteractivePrompt("omp", screen())!;
  const rich = enrichOmpAsk(native, turns(), "session-a");
  expect(rich).toMatchObject({ question, text_format: "markdown", title: "Deployment", custom_option_index: 2 });
  expect(rich.options).toEqual([
    { ...asked.options[0]!, label: "Preview (Recommended)" }, asked.options[1]!,
  ]);
  expect(answerKeys(rich, { option_index: 1 })).toEqual(answerKeys(native, { option_index: 1 }));
  expect(answerKeys(rich, { custom_text: "Keep my `draft`" })).toEqual(answerKeys(native, { custom_text: "Keep my `draft`" }));
  expect(enrichOmpAsk(native, turns([{ ...asked, options: [asked.options[0], { ...asked.options[1], preview: "changed unseen preview" }] }]), "session-a").id).not.toBe(rich.id);
  expect(enrichOmpAsk(native, turns(), "another-session").id).not.toBe(rich.id);
});

test("matches multiselect independently and preserves toggle/submit mapping", () => {
  const native = parseInteractivePrompt("omp", screen(true))!;
  const rich = enrichOmpAsk(native, turns([{ ...asked, multi: true }]), "session-a");
  expect(rich.text_format).toBe("markdown");
  expect(answerKeys(rich, { option_indices: [0, 1] })).toEqual(answerKeys(native, { option_indices: [0, 1] }));
  expect(enrichOmpAsk(native, turns(), "session-a")).toBe(native);
});

test("never borrows settled, old-turn, ambiguous, malformed or differently ordered source text", () => {
  const native = parseInteractivePrompt("omp", screen())!;
  for (const source of [
    turns([asked], "answered"), turns([asked, asked]),
    turns([{ ...asked, question: "A different question with the same choices?" }]),
    turns([{ ...asked, options: [...asked.options].reverse() }]),
    turns([{ ...asked, options: [{ label: "Different" }, asked.options[1]] }]),
    turns([{ ...asked, options: [{ label: "Preview", description: 123 }, asked.options[1]] }]),
    [...turns(), { role: "user" as const, ts: null, parts: [{ kind: "text" as const, text: "new request" }] }],
  ]) expect(enrichOmpAsk(native, source, "session-a")).toBe(native);
  const malformed = turns();
  const part = malformed[0]!.parts[0]!;
  if (part.kind === "tool") part.input = "{";
  expect(enrichOmpAsk(native, malformed, "session-a")).toBe(native);
});
