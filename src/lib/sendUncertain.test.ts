import { describe, expect, it } from "bun:test";

import { sendLeftTheBox } from "./sendUncertain.ts";

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
