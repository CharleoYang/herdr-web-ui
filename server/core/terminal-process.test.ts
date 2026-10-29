import { describe, expect, it } from "bun:test";
import { attachScreenStarted } from "./terminal-process.ts";

// herdr 0.9.5 `terminal attach`, captured through the Rust PTY host with its two startup queries
// taken out (AttachStartupProbes): the setup, then a screen or a refusal's teardown and line
const MOUSE_OFF = "\x1b[?1006l\x1b[?1016l\x1b[?1015l\x1b[?1005l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l";
const SETUP = `${MOUSE_OFF}\x1b[?1049h${MOUSE_OFF}\x1b[?2031l${MOUSE_OFF}\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?2004h\x1b[?7l`;
const TEARDOWN = `\x1b[?7h\x1b[?1004l\x1b[?2004l${MOUSE_OFF}\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[?25h\x1b[0 q`;
const REFUSALS = [
  "herdr: server shut down: terminal attach failed: terminal term_0 already has an attached client; retry with --takeover\r\n",
  "herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\r\n",
];
const SCREEN = "\x1b[?2026h\x1b[?25l\x1b]8;;\x1b\\\x1b[2J\x1b[1;1H\x1b[0;39;49mbash-5.3$ echo PROBE-READY";

describe("attachScreenStarted", () => {
  it("never takes any part of a refusal for a screen, at whatever byte its reads end", () => {
    for (const line of REFUSALS) {
      const output = SETUP + TEARDOWN + line;
      for (let end = 0; end <= output.length; end++) expect([end, attachScreenStarted(output.slice(0, end))]).toEqual([end, false]);
    }
    // a teardown with control sequences or a line break 0.9.5 does not write still waits
    const other = `${SETUP}\x1b[>4;0m\x1b[<u${TEARDOWN}\r\n${REFUSALS[0]}`;
    for (let end = 0; end <= other.length; end++) expect([end, attachScreenStarted(other.slice(0, end))]).toEqual([end, false]);
    // the words of a takeover's diagnostic without herdr's prefix
    expect(attachScreenStarted("terminal attach taken over\r\n")).toBe(false);
  });
  it("takes a screen only from its first printable text, never from an escape alone", () => {
    expect(attachScreenStarted(SETUP)).toBe(false);
    // the OSC (its hyperlink reset), the clear and the colours come first: none of them is the screen yet
    const first = SETUP.length + SCREEN.indexOf("bash");
    for (let end = 0; end <= first; end++) expect([end, attachScreenStarted((SETUP + SCREEN).slice(0, end))]).toEqual([end, false]);
    // an OSC title, a cursor save or an escape cut short, before a refusal (#2255 review)
    for (const lead of ["\x1b]", "\x1b]0;title", "\x1b]0;title\x07", "\x1b7", "\x1b8\x1b(B", "\x1b[", "\x1b[?10"]) {
      expect([lead, attachScreenStarted(SETUP + lead)]).toEqual([lead, false]);
      expect([lead, attachScreenStarted(SETUP + lead + REFUSALS[0])]).toEqual([lead, false]);
    }
    for (let end = first + 1; end <= SETUP.length + SCREEN.length; end++) expect([end, attachScreenStarted((SETUP + SCREEN).slice(0, end))]).toEqual([end, true]);
    // a screen whose first text is not a refusal's start
    expect(attachScreenStarted(`${SETUP}pane text: has a read in progress; retry\r\n`)).toBe(true);
  });
});
