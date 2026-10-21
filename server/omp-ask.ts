import { createHash } from "node:crypto";
import { askedQuestions } from "../shared/askQuestions.ts";
import type { ConversationTurn, InteractivePrompt } from "../shared/protocol.ts";
import { normalizeText, parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { sameText } from "./dialogs/omo.ts";

/** The terminal remains the authority for liveness, current question and answer keys. Only a
 * unique matching ask in the current assistant turn may supply its unabridged Markdown.
 * Never search older turns or match by cwd: they may contain an identical, settled question.
 */
export function enrichOmpAsk(prompt: InteractivePrompt, turns: ConversationTurn[], history: string): InteractivePrompt {
  const parsed = parsedByPublicPrompt.get(prompt);
  const turn = turns.at(-1);
  if (parsed?.responder !== "omp-question" || turn?.role !== "assistant") return prompt;
  const candidates = turn.parts.flatMap((part, callIndex) => {
    if (part.kind !== "tool" || part.name !== "ask" || part.output || part.error) return [];
    let args: unknown;
    try { args = JSON.parse(part.input); } catch { return []; }
    return (askedQuestions("ask", args) ?? []).flatMap((question, questionIndex) =>
      question.multi === prompt.multi_select && question.options.length === prompt.options.length
        && question.options.every((option, index) => normalizeText(option.label) === normalizeText(prompt.options[index]!.label))
        && sameText(prompt.question, question.question)
        ? [{ question, callIndex, questionIndex }] : []);
  });
  if (candidates.length !== 1) return prompt;
  const { question, callIndex, questionIndex } = candidates[0]!;
  const options = question.options.map((option, index) => ({
    label: `${option.label}${index === question.recommended ? " (Recommended)" : ""}`,
    description: option.description, preview: option.preview,
  }));
  const id = createHash("sha256").update(JSON.stringify({
    history, turn: turn.ts, callIndex, questionIndex, question,
  })).digest("hex").slice(0, 12);
  return publicPrompt({ ...parsed, id, title: question.header ?? parsed.title,
    question: question.question, text_format: "markdown", options });
}
