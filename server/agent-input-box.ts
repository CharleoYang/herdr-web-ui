/**
 * The editor's text for the TUIs that draw it between two full-width rules — omp and pi (and the
 * OmO aliases of pi's TUI). Claude draws its own box and has its own reader (`claudeInputBoxText`).
 *
 * Read from the visible screen as text: the last two rules are the editor's borders, the footer
 * (folder, model, context) sits under the lower one. Whatever the reader types sits between them, so
 * an empty editor is an empty (or blank) row there. `null` means "not this shape": a screen without
 * those two rules, or one where a dialog took the editor's place — the app decides nothing then,
 * rather than call a box empty when it cannot see one.
 */

/** a full-width border row: a run of box-drawing horizontals across the line, nothing else */
const RULE = /^\s*[─━]{8,}\s*$/u;

const rows = (screen: string): string[] => screen.split(/\r?\n/u);

export function editorBoxText(screen: string): string | null {
  const lines = rows(screen);
  const rules: number[] = [];
  for (let index = 0; index < lines.length; index++) if (RULE.test(lines[index]!)) rules.push(index);
  if (rules.length < 2) return null;
  const lower = rules[rules.length - 1]!;
  const upper = rules[rules.length - 2]!;
  const inside = lines.slice(upper + 1, lower);
  // a dialog or a panel in the editor's place keeps the rules but fills the rows with its own
  // content: more than a handful of rows is not a one-line editor
  if (inside.length > 12) return null;
  // each row trimmed: the editor's own left padding is not part of what was typed, and the one
  // reader of this text (lib/sendUncertain.ts) compares words, not spaces
  return inside.map((line) => line.trim()).join("\n").trim();
}
