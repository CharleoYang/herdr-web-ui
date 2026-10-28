import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Snapshot the rendering CLI's account, not whichever account is signed in at read time. */
const home = homedir();
const dir = join(home, ".herdr");
const temp = join(dir, `statusline-last.json.${process.pid}`);
try {
  const payload = JSON.parse(await Bun.stdin.text());
  const configDir = process.env["CLAUDE_CONFIG_DIR"];
  let account: { id: string; label: string | null } | null = null;
  try {
    const config = JSON.parse(readFileSync(configDir ? join(configDir, ".claude.json") : join(home, ".claude.json"), "utf8"));
    const oauth = config.oauthAccount;
    if (typeof oauth?.accountUuid === "string" && oauth.accountUuid.trim()) {
      account = { id: oauth.accountUuid.trim(), label: typeof oauth.emailAddress === "string" ? oauth.emailAddress : null };
    }
  } catch { /* An unknown account is never attributed to a sign-in by the reader. */ }
  payload._herdr = { account };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(temp, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
  renameSync(temp, join(dir, "statusline-last.json"));
} catch { /* Capture must not prevent the original status line from rendering. */ }
finally { rmSync(temp, { force: true }); }
