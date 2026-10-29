import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStatusline } from "../server/statusline.ts";

let home: string;
const installer = new URL("./install-statusline-tee.ts", import.meta.url).pathname;
const settings = (configDir = join(home, ".claude")) => join(configDir, "settings.json");
const readSettings = (configDir?: string) => JSON.parse(readFileSync(settings(configDir), "utf8"));
const own = (configDir = join(home, ".claude")) => join(configDir, "herdr-statusline");
const tee = (configDir?: string) => join(own(configDir), "statusline-tee.sh");
const capture = () => join(home, ".herdr", "statusline-last.json");
const env = (configDir = "") => ({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir });
function run(args: string[], configDir?: string) {
  return Bun.spawnSync([process.execPath, installer, ...args], { env: env(configDir) });
}
function install(...args: string[]) {
  const result = run(args);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}
function draw(payload: string, configDir?: string) {
  const result = Bun.spawnSync(["sh", tee(configDir)], { env: env(configDir), stdin: Buffer.from(payload) });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ovis-statusline-install-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(settings(), JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "~/.claude/statusline.sh" } }));
  writeFileSync(join(home, ".claude", "statusline.sh"), "#!/bin/sh\ncat\n", { mode: 0o755 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("statusline installer and capture", () => {
  it("wraps the tilde command from HOME and forwards the original payload unchanged", () => {
    install();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "default-account" } }));
    const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } }, cwd: "/private/project" });
    expect(draw(payload)).toBe(payload);
    expect(readStatusline(home)?.fiveHour?.usedPercent).toBe(12);
    expect(readStatusline(home)?.account?.id).toBe("default-account");
  });

  it("wraps a command with arguments and runs it unchanged", () => {
    writeFileSync(join(home, ".claude", "statusline.sh"), "#!/bin/sh\nprintf '%s|' \"$@\"\ncat\n");
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "sh ~/.claude/statusline.sh --color 'two words'" } }));
    install();
    expect(draw("{}")).toBe("--color|two words|{}");
  });

  it("draws nothing where no status line was set, and still captures the limits", () => {
    writeFileSync(settings(), JSON.stringify({ theme: "dark" }));
    install();
    expect(draw(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 23 } } }))).toBe("");
    expect(readStatusline(home)?.sevenDay?.usedPercent).toBe(23);
  });

  for (const [name, original] of [
    ["an existing status line", '{\n    "statusLine": {"type": "command", "command": "~/.claude/statusline.sh", "padding": 0},\n    "theme": "dark"\n}'],
    ["no status line", '{\n    "theme": "dark",\n    "model": "opus"\n}\n'],
    ["an empty settings object", "{}"],
  ] as const) {
    it(`--remove puts back settings.json with ${name} byte for byte and deletes everything install added`, () => {
      writeFileSync(settings(), original);
      install();
      expect(readFileSync(settings(), "utf8")).not.toBe(original);
      draw(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5 } } }));
      expect(existsSync(capture())).toBe(true);
      install("--remove");
      expect(readFileSync(settings(), "utf8")).toBe(original);
      expect(existsSync(own())).toBe(false);
      expect(existsSync(capture())).toBe(false);
    });
  }

  it("--remove puts back only the status line when other settings changed since the install", () => {
    const original = { type: "command", command: "~/.claude/statusline.sh", padding: 2, refreshInterval: 30 };
    writeFileSync(settings(), JSON.stringify({ theme: "dark", statusLine: original }));
    install();
    expect(readSettings().statusLine).toEqual({ ...original, command: expect.stringContaining("herdr-statusline") });
    writeFileSync(settings(), JSON.stringify({ ...readSettings(), model: "opus" }, null, 2));
    install("--restore");
    expect(readSettings()).toEqual({ theme: "dark", statusLine: original, model: "opus" });
    expect(existsSync(own())).toBe(false);
  });

  it("a reinstall after the status line changed puts back the new one, not the first", () => {
    install();
    install("--remove");
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "echo second" } }));
    install();
    // replaced by hand while installed: the next install wraps this one
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "echo third" } }));
    install();
    expect(draw("{}")).toBe("third\n");
    install("--remove");
    expect(readSettings().statusLine.command).toBe("echo third");
  });

  it("installs into and removes from CLAUDE_CONFIG_DIR, leaving ~/.claude alone", () => {
    const before = readFileSync(settings(), "utf8");
    const configDir = join(home, ".claude-work");
    mkdirSync(configDir);
    const original = JSON.stringify({ statusLine: { type: "command", command: "printf work" } });
    writeFileSync(settings(configDir), original);
    expect(run([], configDir).exitCode).toBe(0);
    expect(readSettings(configDir).statusLine.command).toContain(join(".claude-work", "herdr-statusline"));
    expect(draw("{}", configDir)).toBe("work");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(existsSync(own())).toBe(false);
    expect(run(["--remove"], configDir).exitCode).toBe(0);
    expect(readFileSync(settings(configDir), "utf8")).toBe(original);
    expect(existsSync(own(configDir))).toBe(false);
  });

  it("refuses an unknown argument without touching settings", () => {
    const before = readFileSync(settings(), "utf8");
    expect(run(["--uninstall"]).exitCode).toBe(1);
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(existsSync(own())).toBe(false);
  });

  it("keeps only the quota windows and the account from the payload", () => {
    install();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct", emailAddress: "me@example.com" } }));
    draw(JSON.stringify({
      session_id: "s", cwd: "/private/project", cost: { total_cost_usd: 3 }, model: { id: "m" },
      context_window: { used_percentage: 32 }, transcript_path: "/private/t.jsonl",
      rate_limits: { five_hour: { used_percentage: 17, resets_at: 1793190600, extra: true }, seven_day: { used_percentage: 64, resets_at: 1793343600 }, other: {} },
    }));
    expect(JSON.parse(readFileSync(capture(), "utf8"))).toEqual({
      rate_limits: { five_hour: { used_percentage: 17, resets_at: 1793190600 }, seven_day: { used_percentage: 64, resets_at: 1793343600 } },
      _herdr: { account: { id: "acct", label: "me@example.com" } },
    });
  });

  it("restricts the capture directory and the payload under umask 022 without blocking reads", () => {
    mkdirSync(join(home, ".herdr"), { mode: 0o755 });
    chmodSync(join(home, ".herdr"), 0o755);
    install();
    const payload = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 23 } } });
    const result = Bun.spawnSync(["sh", "-c", 'umask 022; exec sh "$0"', tee()], { env: env(), stdin: Buffer.from(payload) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(payload);
    expect(statSync(join(home, ".herdr")).mode & 0o777).toBe(0o700);
    expect(statSync(capture()).mode & 0o777).toBe(0o600);
    expect(readStatusline(home)?.sevenDay?.usedPercent).toBe(23);
  });

  it("snapshots the rendering CLI's account and does not relabel it after a sign-in change", () => {
    install();
    const configDir = join(home, ".claude-work");
    mkdirSync(configDir);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "personal" } }));
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "work", emailAddress: "work@example.com" } }));
    const result = Bun.spawnSync(["sh", tee()], { env: env(configDir), stdin: Buffer.from(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } })) });
    expect(result.exitCode).toBe(0);
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "other" } }));
    expect(readStatusline(home)?.account).toEqual({ id: "work", label: "work@example.com" });
  });

  it("still renders the original status line when the payload cannot be captured, keeping the last capture", () => {
    install();
    draw(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 40 } } }));
    expect(draw("not json")).toBe("not json");
    // a render without limits (before Claude's first answer) does not wipe the last reading
    draw(JSON.stringify({ model: { id: "m" } }));
    expect(readStatusline(home)?.fiveHour?.usedPercent).toBe(40);
  });
});
