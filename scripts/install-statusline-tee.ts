/**
 * Point Claude Code's status line at scripts/statusline-tee.sh, so the payload it draws from (the
 * five-hour and weekly limits, the context window) lands in ~/.herdr/statusline-last.json — where
 * server/statusline.ts reads the numbers the web UI shows beside the model.
 *
 * Idempotent, and reversible: the command that was there before this script ran is kept in
 * ~/.herdr/statusline-original.json, and `--restore` puts it back. The tee draws the same line the
 * old command drew. Its Bun capture helper snapshots the rendering CLI's account from .claude.json
 * (or CLAUDE_CONFIG_DIR/.claude.json); an unknown account is not assigned to any sign-in.
 *
 *   bun scripts/install-statusline-tee.ts            # install (or say it is already installed)
 *   bun scripts/install-statusline-tee.ts --restore  # put the previous command back
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = homedir();
const herdr = join(home, ".herdr");
const tee = join(herdr, "statusline-tee.sh");
const keep = join(herdr, "statusline-original.json");
const settings = join(home, ".claude", "settings.json");
const COMMAND = "~/.herdr/statusline-tee.sh";

const readSettings = (): Record<string, unknown> => {
  if (!existsSync(settings)) throw new Error(`${settings} is missing: is Claude Code installed?`);
  return JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
};

const writeSettings = (value: Record<string, unknown>): void => writeFileSync(settings, `${JSON.stringify(value, null, 2)}\n`);

function main(argv: readonly string[]): number {
  if (argv.includes("--restore")) {
    if (!existsSync(keep)) {
      console.error("nothing to restore: ~/.herdr/statusline-original.json is not there");
      return 1;
    }
    const original = JSON.parse(readFileSync(keep, "utf8")) as { statusLine?: unknown };
    const settingsValue = readSettings();
    if (original.statusLine === undefined) delete settingsValue["statusLine"];
    else settingsValue["statusLine"] = original.statusLine;
    writeSettings(settingsValue);
    console.log("restored the status line that was there before the tee");
    return 0;
  }

  const current = readSettings();
  const statusLine = current["statusLine"] as { command?: string; [key: string]: unknown } | undefined;
  if (statusLine?.command === COMMAND) {
    console.log(`already installed: ${settings} runs ${COMMAND}`);
    return 0;
  }
  // the command this wraps must exist, or the status line would draw nothing at all
  const previous = statusLine?.command ?? "~/.claude/statusline.sh";
  const script = previous.startsWith("~/") ? resolve(home, previous.slice(2)) : resolve(home, previous);
  if (!existsSync(script)) throw new Error(`the status line command (${previous}) is not a file this can wrap`);

  mkdirSync(herdr, { recursive: true, mode: 0o700 });
  chmodSync(herdr, 0o700);
  copyFileSync(new URL("./statusline-capture.ts", import.meta.url), join(herdr, "statusline-capture.ts"));
  copyFileSync(new URL("./statusline-tee.sh", import.meta.url), tee);
  chmodSync(tee, 0o755);
  const scriptBody = readFileSync(tee, "utf8")
    .replace('"$HOME/.claude/statusline.sh"', JSON.stringify(script))
    .replace('"bun"', JSON.stringify(process.execPath));
  writeFileSync(tee, scriptBody);
  if (!existsSync(keep)) writeFileSync(keep, `${JSON.stringify({ statusLine, settings }, null, 2)}\n`);
  current["statusLine"] = { ...statusLine, type: "command", command: COMMAND };
  writeSettings(current);
  console.log(`installed: ${settings} runs ${COMMAND}, which keeps the payload in ~/.herdr/statusline-last.json and then runs ${previous}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
