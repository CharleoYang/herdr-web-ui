import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStatusline } from "../server/statusline.ts";

let home: string;
const installer = new URL("./install-statusline-tee.ts", import.meta.url).pathname;
const settings = () => join(home, ".claude", "settings.json");
const readSettings = () => JSON.parse(readFileSync(settings(), "utf8"));
function install(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, installer, ...args], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "" } });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ovis-statusline-install-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(settings(), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(home, ".claude", "statusline.sh"), "#!/bin/sh\ncat\n", { mode: 0o755 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("statusline installer and capture", () => {
  it("installs the default tilde command from HOME and forwards the original payload unchanged", () => {
    install();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "default-account" } }));
    const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } }, cwd: "/private/project" });
    const result = Bun.spawnSync(["sh", join(home, ".herdr", "statusline-tee.sh")], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "" }, stdin: Buffer.from(payload) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(payload);
    expect(readStatusline(home)?.fiveHour?.usedPercent).toBe(12);
    expect(readStatusline(home)?.account?.id).toBe("default-account");
  });

  it("restores absence rather than adding a null statusLine", () => {
    install();
    expect(JSON.parse(readFileSync(join(home, ".herdr", "statusline-original.json"), "utf8"))).not.toHaveProperty("statusLine");
    install("--restore");
    expect(readSettings()).toEqual({ theme: "dark" });
  });

  it("preserves status-line options on install and the full original object on restore", () => {
    const original = { type: "command", command: "~/.claude/statusline.sh", padding: 2, refreshInterval: 30 };
    writeFileSync(settings(), JSON.stringify({ theme: "dark", statusLine: original }));
    install();
    expect(readSettings().statusLine).toEqual({ ...original, command: "~/.herdr/statusline-tee.sh" });
    install();
    install("--restore");
    expect(readSettings().statusLine).toEqual(original);
  });

  it("restricts an existing capture directory and the payload under umask 022 without blocking reads", () => {
    mkdirSync(join(home, ".herdr"), { mode: 0o755 });
    chmodSync(join(home, ".herdr"), 0o755);
    install();
    const payload = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 23 } } });
    const result = Bun.spawnSync(["sh", "-c", 'umask 022; exec sh "$HOME/.herdr/statusline-tee.sh"'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "" }, stdin: Buffer.from(payload) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(payload);
    expect(statSync(join(home, ".herdr")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".herdr", "statusline-last.json")).mode & 0o777).toBe(0o600);
    expect(readStatusline(home)?.sevenDay?.usedPercent).toBe(23);
  });

  it("snapshots the rendering CLI's account and does not relabel it after a sign-in change", () => {
    install();
    const configDir = join(home, ".claude-work");
    mkdirSync(configDir);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "personal" } }));
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "work", emailAddress: "work@example.com" } }));
    const result = Bun.spawnSync(["sh", join(home, ".herdr", "statusline-tee.sh")], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir }, stdin: Buffer.from(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } })) });
    expect(result.exitCode).toBe(0);
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "other" } }));
    expect(readStatusline(home)?.account).toEqual({ id: "work", label: "work@example.com" });
  });

  it("still renders the original status line when the payload cannot be captured", () => {
    install();
    const result = Bun.spawnSync(["sh", join(home, ".herdr", "statusline-tee.sh")], { env: { ...process.env, HOME: home }, stdin: Buffer.from("not json") });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("not json");
    expect(readStatusline(home)).toBeNull();
  });
});
