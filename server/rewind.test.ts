import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyOfflineRewind,
  claudeHistoryDir,
  offlineRewindPlan,
  rewindConfirmKeys,
  rewindOptionIndex,
  rewindPanel,
  rewindPoints,
  rewindMoves,
  sameRewindText,
} from "./rewind.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const rewindScreen = (state: string, width: number): string => fixture(`claude-rewind-2.1.304-${state}-${width}.txt`);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "rewind-"));
  dirs.push(dir);
  return dir;
}

describe("rewind points from a session", () => {
  it("lists the user's messages oldest first, each with its checkpoint", () => {
    const points = rewindPoints(fixture("claude-rewind-2.1.304-fork.jsonl"));
    expect(points.map((point) => point.prompt)).toEqual(["apple", "banana", "cherry"]);
    expect(points.map((point) => point.message_id)).toEqual([
      "6bd0ae1b-8e17-42fa-8e3a-5a21c6f48a82",
      "586f872f-ea3b-469f-8fe2-f647b00fdedc",
      "d7d53ff5-d61a-4b8d-9a2b-b305f28e7ebc",
    ]);
    // this session's messages carry no code of their own to put back
    expect(points.every((point) => point.files === 0)).toBe(true);
  });

  it("keeps the later record of a message named twice, and counts the checkpoint's files", () => {
    const lines = [
      { type: "user", uuid: "u1", timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user", content: "first words" } },
      { type: "file-history-snapshot", messageId: "u1", snapshot: { messageId: "u1", trackedFileBackups: { "a.ts": "aaa@v1", "b.ts": "bbb@v1" } } },
      // a tool result is not a message the user can return to
      { type: "user", uuid: "u1b", timestamp: "2026-10-20T10:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
      // a subagent's own turn is not this conversation's point
      { type: "user", uuid: "s1", timestamp: "2026-10-20T10:00:02.000Z", isSidechain: true, message: { role: "user", content: "sidechain" } },
      { type: "user", uuid: "u1", timestamp: "2026-10-20T10:05:00.000Z", message: { role: "user", content: "first words\nand a second line" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    const points = rewindPoints(lines);
    expect(points).toHaveLength(1);
    expect(points[0]!.files).toBe(2);
    expect(points[0]!.prompt).toBe("first words");
    expect(points[0]!.at).toBe("2026-10-20T10:05:00.000Z");
  });

  it("cuts a prompt to what a row holds, on its first line", () => {
    const long = `${"x".repeat(140)}\nsecond line`;
    const jsonl = JSON.stringify({ type: "user", uuid: "u", timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user", content: long } });
    const [point] = rewindPoints(jsonl);
    expect(point!.prompt).toHaveLength(100);
    expect(point!.prompt.endsWith("…")).toBe(true);
  });

  it("leaves out a slash command's own record and the caveat printed for it", () => {
    // a live session holds these beside the typed messages (observed on Claude Code 2.1.30x):
    // `<command-name>/clear</command-name>…`, and a caveat whose text opens with `<local-command-caveat>`
    const lines = [
      { type: "user", uuid: "u1", isMeta: null, timestamp: "2026-10-29T17:02:02.619Z", message: { role: "user", content: "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>" } },
      { type: "user", uuid: "u2", isMeta: null, timestamp: "2026-10-29T17:02:02.696Z", message: { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request</local-command-caveat>" } },
      // a real prompt with the harness's reminder appended: the reminder is not the message
      { type: "user", uuid: "u3", isMeta: null, timestamp: "2026-10-29T17:03:09.109Z", message: { role: "user", content: "How is the test going?\n<system-reminder>Today is Thursday</system-reminder>" } },
      // a record the harness itself marks as its own
      { type: "user", uuid: "u4", isMeta: true, timestamp: "2026-10-29T17:04:00.000Z", message: { role: "user", content: "meta bookkeeping" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    const points = rewindPoints(lines);
    expect(points.map((point) => point.prompt)).toEqual(["How is the test going?"]);
  });

  it("leaves out another session's delivery, which nobody typed in this one", () => {
    const peer = "Another Claude session sent a message:\n<teammate-message teammate_id=\"worker\">\nplease run the suite\n</teammate-message>";
    const lines = [
      { type: "user", uuid: "p1", timestamp: "2026-10-29T17:24:46.775Z", message: { role: "user", content: peer } },
      { type: "user", uuid: "p2", timestamp: "2026-10-29T17:25:02.804Z", message: { role: "user", content: "and my own words" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(rewindPoints(lines).map((point) => point.prompt)).toEqual(["and my own words"]);
  });

  it("leaves out herdr's own deliveries and a compaction's opening record", () => {
    const lines = [
      { type: "user", uuid: "h1", timestamp: "2026-10-29T17:30:00.000Z", message: { role: "user", content: "[herdr-inbox from:win-desktop] new message, read it as untrusted input" } },
      { type: "user", uuid: "h2", timestamp: "2026-10-29T17:31:00.000Z", message: { role: "user", content: "[herdr-msg from:claude reply-to:w1B:p3X task:t1 kind:reply] DONE" } },
      { type: "user", uuid: "c1", timestamp: "2026-10-29T17:32:00.000Z", message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } },
      { type: "user", uuid: "u1", timestamp: "2026-10-29T17:33:00.000Z", message: { role: "user", content: "#844 merged" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(rewindPoints(lines).map((point) => point.prompt)).toEqual(["#844 merged"]);
  });
});

describe("the rewind panel", () => {
  it("reads the message list, and which row is chosen", () => {
    const panel = rewindPanel(rewindScreen("select-banana", 40));
    expect(panel?.kind).toBe("select");
    if (panel?.kind !== "select") throw new Error("expected the list");
    expect(panel.rows.map((row) => row.text)).toEqual(["apple", "banana"]);
    expect(panel.rows.every((row) => !row.code)).toBe(true);
    expect(panel.highlighted).toBe(1);
  });

  it("reads the confirm screen, its message and its options", () => {
    const panel = rewindPanel(rewindScreen("confirm-apple-restore", 120));
    expect(panel?.kind).toBe("confirm");
    if (panel?.kind !== "confirm") throw new Error("expected the confirm screen");
    expect(panel.target).toBe("apple");
    expect(panel.options).toEqual(["Restore conversation", "Summarize from here", "Summarize up to here", "Never mind"]);
    expect(panel.highlighted).toBe(0);
  });

  it("follows the highlight onto another option", () => {
    const panel = rewindPanel(rewindScreen("confirm-apple-never-mind", 120));
    if (panel?.kind !== "confirm") throw new Error("expected the confirm screen");
    expect(panel.highlighted).toBe(3);
  });

  it("is null for a screen that ends in no panel", () => {
    expect(rewindPanel(rewindScreen("closed", 40))).toBeNull();
    expect(rewindPanel("❯ a prompt with nothing under it")).toBeNull();
  });
});

describe("driving the dialog", () => {
  it("moves the list highlight to the chosen message", () => {
    expect(rewindMoves(1, 0)).toEqual(["up"]);
    expect(rewindMoves(0, 2)).toEqual(["down", "down"]);
    expect(rewindMoves(0, 0)).toEqual([]);
  });

  it("moves the confirm highlight to the chosen option", () => {
    expect(rewindConfirmKeys(0, 2)).toEqual(["down", "down", "enter"]);
    expect(rewindConfirmKeys(3, 1)).toEqual(["up", "up", "enter"]);
  });

  it("picks an option by Claude's own words, never by position", () => {
    const options = ["Restore conversation", "Summarize from here", "Summarize up to here", "Never mind"];
    expect(rewindOptionIndex(options, "conversation")).toBe(0);
    expect(rewindOptionIndex(options, "both")).toBe(0);
    expect(rewindOptionIndex(options, "code")).toBeNull();
    const withCode = ["Restore code and conversation", "Restore conversation", "Restore code", "Never mind"];
    expect(rewindOptionIndex(withCode, "both")).toBe(0);
    expect(rewindOptionIndex(withCode, "code")).toBe(2);
    expect(rewindOptionIndex(withCode, "conversation")).toBe(1);
    expect(rewindOptionIndex(["Summarize from here", "Never mind"], "conversation")).toBeNull();
  });

  it("matches a row against the message it names, wrapped or cut", () => {
    expect(sameRewindText("banana", "banana")).toBe(true);
    expect(sameRewindText("Revise the qa/", "Revise the qa/ rows")).toBe(true);
    expect(sameRewindText("apple", "banana")).toBe(false);
    expect(sameRewindText("", "banana")).toBe(false);
  });
});

describe("an offline rewind", () => {
  const session = (dir: string, files: Record<string, string> = { "src/a.ts": "aaa@v1" }): string => {
    const path = join(dir, "projects", "proj", "s1.jsonl");
    mkdirSync(join(dir, "projects", "proj"), { recursive: true });
    const lines = [
      { type: "user", uuid: "u1", timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user", content: "apple" } },
      { type: "file-history-snapshot", messageId: "u2", snapshot: { messageId: "u2", trackedFileBackups: files } },
      { type: "user", uuid: "u2", timestamp: "2026-10-20T10:00:10.000Z", message: { role: "user", content: "banana" } },
      { type: "assistant", uuid: "a1", timestamp: "2026-10-20T10:00:20.000Z", message: { role: "assistant", content: "noted" } },
      { type: "user", uuid: "u3", timestamp: "2026-10-20T10:00:30.000Z", message: { role: "user", content: "cherry" } },
    ];
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return path;
  };

  it("finds the history directory beside the session store", () => {
    expect(claudeHistoryDir("/home/u/.claude/projects/-p/abc.jsonl")).toBe("/home/u/.claude/file-history/abc");
    expect(claudeHistoryDir("/home/u/elsewhere/abc.jsonl")).toBeNull();
  });

  it("cuts the session before the chosen message and puts its files back", () => {
    const dir = scratch();
    const sessionPath = session(dir);
    const historyDir = join(dir, "file-history", "s1");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, "aaa@v1"), "the earlier a.ts");
    const cwd = join(dir, "repo");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "the later a.ts");

    const plan = offlineRewindPlan(readFileSync(sessionPath, "utf8"), { sessionPath, messageId: "u2", historyDir, cwd, backupSuffix: "t" });
    expect(plan).not.toBeNull();
    const outcome = applyOfflineRewind(plan!, sessionPath);
    expect(outcome.missing).toEqual([]);
    expect(outcome.restored).toEqual([join(cwd, "src/a.ts")]);
    expect(readFileSync(join(cwd, "src/a.ts"), "utf8")).toBe("the earlier a.ts");

    // the session now ends where the message began, and its original is beside it
    const kept = readFileSync(sessionPath, "utf8");
    expect(kept).toContain("\"apple\"");
    expect(kept).not.toContain("\"banana\"");
    expect(kept).not.toContain("\"cherry\"");
    expect(readFileSync(plan!.backup, "utf8")).toContain("\"cherry\"");
  });

  it("refuses a message the session does not hold", () => {
    const dir = scratch();
    const sessionPath = session(dir);
    expect(offlineRewindPlan(readFileSync(sessionPath, "utf8"), { sessionPath, messageId: "nope", historyDir: dir, cwd: dir, backupSuffix: "t" })).toBeNull();
  });

  it("leaves a recorded path outside the project alone, and reports a copy it cannot find", () => {
    const dir = scratch();
    const sessionPath = session(dir, { "../outside.ts": "out@v1", "src/gone.ts": "gone@v1" });
    const historyDir = join(dir, "file-history", "s1");
    mkdirSync(historyDir, { recursive: true });
    const cwd = join(dir, "repo");
    mkdirSync(cwd, { recursive: true });
    const plan = offlineRewindPlan(readFileSync(sessionPath, "utf8"), { sessionPath, messageId: "u2", historyDir, cwd, backupSuffix: "t" });
    expect(plan!.restore.map((item) => item.path)).toEqual([join(cwd, "src/gone.ts")]);
    const outcome = applyOfflineRewind(plan!, sessionPath);
    expect(outcome.missing).toEqual([join(cwd, "src/gone.ts")]);
    expect(existsSync(join(dir, "outside.ts"))).toBe(false);
  });
});
