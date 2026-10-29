import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
/**
 * The capture runs in the background: fd 3, a copy of stdout it inherits, keeps stdout open until it
 * has written, so the spawn's read to the end waits for the capture rather than a guessed delay.
 */
const finished = (script: string): string[] => ["sh", "-c", `sh "$0" 3>&1`, script];
function draw(payload: string, configDir?: string) {
  const result = Bun.spawnSync(finished(tee(configDir)), { env: env(configDir), stdin: Buffer.from(payload), timeout: 10_000 });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}
const settingsCommand = (configDir?: string): string => readSettings(configDir).statusLine.command;
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

  it("never wraps its own wrapper, however the config dir or the command is spelled", () => {
    const real = join(home, ".claude-real");
    const link = join(home, ".claude-link");
    mkdirSync(real);
    symlinkSync(real, link);
    const original = JSON.stringify({ statusLine: { type: "command", command: "printf orig" } });
    writeFileSync(settings(real), original);
    expect(run([], real).exitCode).toBe(0);
    const again = run([], link);
    expect(again.exitCode).toBe(0);
    expect(again.stdout.toString()).toStartWith("already installed");
    expect(draw("{}", link)).toBe("orig");
    writeFileSync(settings(real), JSON.stringify({ statusLine: { type: "command", command: `sh ${settingsCommand(real)}` } }));
    const wrapped = readFileSync(settings(real), "utf8");
    expect(run([], real).exitCode).toBe(1);
    for (const command of [
      `sh ${join(real, "herdr-statusline")}//statusline-tee.sh`,
      `sh "${join(real, "herdr-statusline")}/./statusline-tee.sh"`,
      `sh '${join(link, ".", "herdr-statusline")}/./statusline-tee.sh'`,
      `sh ${join(real, "herdr-statusline").replaceAll("/", "\\/")}/.\\/statusline-tee.sh`,
    ]) {
      writeFileSync(settings(real), JSON.stringify({ statusLine: { type: "command", command } }));
      expect(run([], real).exitCode).toBe(1);
    }
    writeFileSync(settings(real), wrapped);
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: settingsCommand(real) } }));
    const other = readFileSync(settings(), "utf8");
    expect(run([]).exitCode).toBe(1);
    expect(readFileSync(settings(), "utf8")).toBe(other);
    expect(readFileSync(settings(real), "utf8")).toBe(wrapped);
    expect(run(["--remove"], link).exitCode).toBe(0);
    expect(readSettings(real).statusLine.command).toBe("printf orig");
  });

  it("knows a wrapper path quoted with spaces in it", () => {
    const spaced = join(home, "Claude Config");
    mkdirSync(spaced);
    writeFileSync(settings(spaced), JSON.stringify({ statusLine: { type: "command", command: "printf orig" } }));
    expect(run([], spaced).exitCode).toBe(0);
    expect(draw("{}", spaced)).toBe("orig");
    writeFileSync(settings(spaced), JSON.stringify({ statusLine: { type: "command", command: `sh "${spaced}/herdr-statusline/./statusline-tee.sh"` } }));
    expect(run([], spaced).exitCode).toBe(1);
    expect(run(["--remove"], spaced).exitCode).toBe(0);
    expect(readSettings(spaced).statusLine.command).toBe("printf orig");
  });

  it("a wrapper run inside itself draws nothing instead of running forever", () => {
    install();
    const result = Bun.spawnSync(["sh", tee()], { env: { ...env(), HERDR_STATUSLINE_TEE: "1" }, stdin: Buffer.from("{}"), timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  it("hands the original command the payload byte for byte, trailing newline included", () => {
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "IFS= read -r payload && printf OK" } }));
    install();
    expect(draw("{}\n")).toBe("OK");
  });

  it("writes nothing through a link in its directory and leaves the user's files there alone", () => {
    mkdirSync(own());
    writeFileSync(join(home, "outside.txt"), "keep");
    symlinkSync(join(home, "outside.txt"), join(own(), "statusline-capture.ts"));
    const before = readFileSync(settings(), "utf8");
    expect(run([]).exitCode).toBe(1);
    expect(readFileSync(join(home, "outside.txt"), "utf8")).toBe("keep");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    rmSync(own(), { recursive: true });
    install();
    writeFileSync(join(own(), "user-notes.txt"), "keep");
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(readFileSync(join(own(), "user-notes.txt"), "utf8")).toBe("keep");
    expect(existsSync(tee())).toBe(false);
  });

  it("--remove deletes nothing through a linked directory", () => {
    install();
    const outside = join(home, "outside");
    mkdirSync(outside);
    for (const name of ["install.json", "statusline-tee.sh", "statusline-capture.ts"]) writeFileSync(join(outside, name), readFileSync(join(own(), name)));
    rmSync(own(), { recursive: true });
    symlinkSync(outside, own());
    expect(run(["--remove"]).exitCode).toBe(1);
    expect(existsSync(join(outside, "statusline-tee.sh"))).toBe(true);
    expect(existsSync(join(outside, "install.json"))).toBe(true);
  });

  it("draws the line and ends without waiting for the capture", () => {
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "printf drawn" } }));
    install();
    const gate = join(home, "gate");
    expect(Bun.spawnSync(["mkfifo", gate]).exitCode).toBe(0);
    // the capture blocks until the test opens the gate, after the wrapper has already ended
    writeFileSync(join(own(), "statusline-capture.ts"), `require("node:fs").readFileSync(${JSON.stringify(gate)});\n`);
    const result = Bun.spawnSync(["sh", tee()], { env: env(), stdin: Buffer.from("{}"), timeout: 10_000 });
    writeFileSync(gate, "go");
    expect(result.signalCode ?? null).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("drawn");
  });

  it("clears what a killed install left behind instead of refusing the next one", () => {
    mkdirSync(own());
    const leftover = join(own(), ".install.json.4242.0b0e7f5c-8a1d-4c3e-9f2a-7d6b5c4a3e21.tmp");
    writeFileSync(leftover, "{");
    install();
    expect(existsSync(leftover)).toBe(false);
    expect(draw("{}")).toBe("{}");
    writeFileSync(leftover, "{");
    install("--remove");
    expect(existsSync(own())).toBe(false);
  });

  it("keeps settings.json whole when a write fails, so a later --remove still recovers it", () => {
    const before = readFileSync(settings(), "utf8");
    install();
    const installed = readFileSync(settings(), "utf8");
    const failed = Bun.spawnSync(["sh", "-c", 'ulimit -f 0; exec "$0" "$1" --remove', process.execPath, installer], { env: env() });
    expect(failed.exitCode).not.toBe(0);
    expect(readFileSync(settings(), "utf8")).toBe(installed);
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  it("rewrites the file a linked settings.json points at and keeps the link", () => {
    const dotfiles = join(home, "dotfiles-settings.json");
    const original = JSON.stringify({ statusLine: { type: "command", command: "printf linked" } });
    writeFileSync(dotfiles, original);
    rmSync(settings());
    symlinkSync(dotfiles, settings());
    install();
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(draw("{}")).toBe("linked");
    install("--remove");
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(readFileSync(dotfiles, "utf8")).toBe(original);
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
    const result = Bun.spawnSync(["sh", "-c", 'umask 022; exec sh "$0" 3>&1', tee()], { env: env(), stdin: Buffer.from(payload), timeout: 10_000 });
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
    const result = Bun.spawnSync(finished(tee()), { env: env(configDir), stdin: Buffer.from(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } })), timeout: 10_000 });
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
