import { describe, expect, it } from "bun:test";

import { sendLeftTheBox, uncertainSend } from "./sendUncertain.ts";

describe("sendLeftTheBox", () => {
  const sent = "还有个问题是 claude code 的消息其实已经发送上去了";

  it("reads an empty box as: the words left it", () => {
    expect(sendLeftTheBox(sent, "")).toBe(true);
    expect(sendLeftTheBox(sent, "   \n ")).toBe(true);
    // the box's own caret, with nothing after it
    expect(sendLeftTheBox(sent, "❯")).toBe(true);
    expect(sendLeftTheBox(sent, "│ ❯ │")).toBe(true);
    expect(sendLeftTheBox(sent, "› ")).toBe(true);
  });

  it("keeps a box that still holds the message: nothing left, the reader decides", () => {
    expect(sendLeftTheBox(sent, sent)).toBe(false);
    // a wrapped copy is the same message (compose.sameMessage drops the whitespace)
    expect(sendLeftTheBox(sent, "还有个问题是 claude code 的\n消息其实已经发送上去了")).toBe(false);
  });

  it("decides nothing for a box holding something else", () => {
    // ours may have been replaced rather than sent: no proof either way
    expect(sendLeftTheBox(sent, "another draft")).toBe(false);
  });

  it("decides nothing when the box could not be read", () => {
    // null: an older server, a clipped box, a failed read
    expect(sendLeftTheBox(sent, null)).toBe(false);
  });
});

describe("uncertainSend", () => {
  it("takes the two refusals that leave delivery unknown", () => {
    expect(uncertainSend("submit_partial", "the draft was cleared but sending was not confirmed")).toBe(true);
    expect(uncertainSend("closed", "herdr closed the connection before answering agent.prompt")).toBe(true);
    expect(uncertainSend("closed", "herdr closed the connection before answering pane.send_text")).toBe(true);
    expect(uncertainSend("socket_error", "herdr socket error ... answering pane.send_keys")).toBe(true);
  });

  it("leaves every other refusal a refusal", () => {
    // a read that lost its connection typed nothing
    expect(uncertainSend("closed", "herdr closed the connection before answering pane.read")).toBe(false);
    for (const code of ["agent_blocked", "agent_not_found", "agent_not_ready", "input_draft", "timeout", "disconnected"]) {
      expect(uncertainSend(code, "herdr closed the connection before answering agent.prompt")).toBe(false);
    }
  });
});
