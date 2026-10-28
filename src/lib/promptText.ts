import type { CardText, ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";
import { askedQuestions } from "./askQuestions.ts";
import { t as inCurrentLanguage, type Translate } from "./i18n.ts";

/** Card text the bridge wrote itself (shared/card-text.ts), in the user's language: its key translated, its values filled in. */
export function cardText(card: CardText, t: Translate = inCurrentLanguage): string {
  const vars = card.vars === undefined ? undefined
    : Object.fromEntries(Object.entries(card.vars).map(([name, value]) => [name, value !== null && typeof value === "object" ? cardText(value, t) : value]));
  return t(card.key, vars);
}

/**
 * Claude's words read off the screen over its question (`screen_words`, #2088), for the card to show
 * while the chat has no record of them: Claude Code 2.1.311 writes the turn to its session file only
 * with the answer. Once the turn in progress (the transcript's last, Claude's) holds this question's
 * call, still waiting, the session file has the turn and the chat shows Claude's own text: the card
 * leaves the screen's copy out. The call must ask what the card asks, under its header and with its
 * options; a call in an earlier turn (one an interrupted turn left waiting, the same question asked
 * again) says nothing of these words.
 */
export function screenWordsToShow(prompt: InteractivePrompt, turns: readonly ConversationTurn[]): string | null {
  if (!prompt.screen_words) return null;
  const same = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
  const labels = prompt.options.map((option) => option.label);
  // the card's title is the question's header (`Fix`, or `Fix · 1 of 2` in a form) unless the bridge wrote it
  const headed = (header: string | null): boolean => prompt.own_text?.title !== undefined || header === null
    || same(prompt.title, header) || prompt.title.startsWith(`${header.trim()} · `);
  const asksThis = (input: string): boolean => {
    let args: unknown;
    try { args = JSON.parse(input); } catch { return false; }
    return askedQuestions("AskUserQuestion", args)?.some((question) => same(question.question, prompt.question) && headed(question.header)
      && question.options.length === labels.length && question.options.every((option, index) => same(option.label, labels[index]!))) ?? false;
  };
  const turn = turns.at(-1);
  const recorded = turn?.role === "assistant" && turn.parts.some((part) =>
    part.kind === "tool" && part.name === "AskUserQuestion" && part.state === "pending" && asksThis(part.input));
  return recorded ? null : prompt.screen_words;
}

/** At most `limit` UTF-16 units of `text`, never ending on half of a character (a lone high surrogate). */
function capped(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The words a prompt card shows: the bridge's own (`own_text`: a title it gave the card, the Close an
 * Esc is offered as) in the user's language, and the agent's own text as the agent wrote it.
 */
export function promptWords(prompt: InteractivePrompt, t: Translate = inCurrentLanguage) {
  const own = prompt.own_text;
  const words = (text: string, card: CardText | undefined): string => card === undefined ? text : cardText(card, t);
  return {
    title: words(prompt.title, own?.title),
    question: words(prompt.question, own?.question),
    // the bridge shows at most 12,000 characters of a body (finishPrompt): a translated one too
    body: prompt.body === null ? null : capped(words(prompt.body, own?.body), 12_000),
    label: (index: number): string => words(prompt.options[index]?.label ?? "", own?.labels?.[index]),
    description: (index: number): string | null => {
      const description = prompt.options[index]?.description ?? null;
      return description === null ? null : words(description, own?.descriptions?.[index]);
    },
    step: (index: number): string => words(prompt.steps?.[index]?.label ?? "", own?.steps?.[index]),
  };
}
