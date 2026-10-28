import { describe, expect, it } from "bun:test";

import { currentWaitingSends, forgetWaitingSends, rememberWaitingSend, settleWaitingSends, transcriptHolds, waitingKey, waitingText } from "./sentWaiting.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";

const user = (text: string, at = 2): ConversationTurn => ({ role: "user", ts: new Date(at).toISOString(), parts: [{ kind: "text", text }] });
const assistant = (text: string): ConversationTurn => ({ ...user(text), role: "assistant" });

describe("waitingText", () => {
  const send = { pane: "p1", text: "还有发消息提示：未确认。重新发送前请检查终端。", at: 1 };

  it("keeps a sent message in view until the transcript has it", () => {
    // Claude writes the user turn only when its next turn starts: until then the chat shows nothing
    expect(waitingText(send, [assistant("earlier")])).toBe(send.text);
    expect(waitingText(send, [assistant("earlier"), user(send.text)])).toBeNull();
  });

  it("reads a rewrapped or reflowed copy as the same message", () => {
    const wrapped = send.text.replace("：", "：\n");
    expect(transcriptHolds(send, [user(wrapped)])).toBe(true);
    expect(transcriptHolds(send, [user(`  ${send.text}  `)])).toBe(true);
  });

  it("does not take another turn's words for it", () => {
    expect(transcriptHolds(send, [user("还有发消息提示")])).toBe(false);
    expect(transcriptHolds(send, [assistant(send.text)])).toBe(false);
  });

  it("says nothing for an empty message or no message", () => {
    expect(waitingText(null, [])).toBeNull();
    expect(waitingText({ ...send, text: "   " }, [])).toBeNull();
    expect(waitingText({ ...send, text: "x" }, [])).toBe("x");
  });

  it("keeps a repeated message waiting when only an earlier matching user turn exists", () => {
    const repeated = { ...send, at: Date.parse("2026-10-29T10:00:01Z") };
    const earlier = { ...user(send.text), ts: "2026-10-29T10:00:00Z" };
    expect(waitingText(repeated, [earlier])).toBe(send.text);
  });

  it("does not settle pending yes from yes, please proceed with the changes", () => {
    expect(waitingText({ ...send, text: "yes" }, [user("yes, please proceed with the changes")])).toBe("yes");
  });

  it("does not settle an unmarked shortened copy", () => {
    const text = "Please review the complete implementation and report the remaining issues";
    expect(transcriptHolds({ ...send, text }, [user("Please review the complete implementation")])).toBe(false);
  });

  it("matches a genuinely shortened copy only with its explicit ellipsis", () => {
    const text = "Please review the complete implementation and report the remaining issues";
    expect(transcriptHolds({ ...send, text }, [user("Please review the complete implementation…")])).toBe(true);
    expect(transcriptHolds({ ...send, text }, [user("Please review the complete implementation...")])).toBe(true);
  });

  it("keeps a second send's own waiting line without overwriting the first", () => {
    const key = waitingKey("local", "two-sends");
    try {
      rememberWaitingSend(key, "first message", 1);
      rememberWaitingSend(key, "second message", 2);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["first message", "second message"]);
      const firstTurn = user("first message", 3);
      settleWaitingSends(key, [firstTurn]);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["second message"]);
      settleWaitingSends(key, [firstTurn, user("second message", 4)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("one turn settles only one of two identical sends, even across refreshes", () => {
    const key = waitingKey("local", "identical-sends");
    try {
      rememberWaitingSend(key, "repeat", 1);
      rememberWaitingSend(key, "repeat", 1);
      const original = currentWaitingSends(key);
      const firstTurn = user("repeat", 3);
      settleWaitingSends(key, [firstTurn]);
      expect(currentWaitingSends(key)).toEqual([original[1]!]);
      settleWaitingSends(key, [firstTurn]);
      expect(currentWaitingSends(key)).toEqual([original[1]!]);
      settleWaitingSends(key, [firstTurn, user("repeat", 4)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a send with no transcript turn and settles it when its delayed turn appears", () => {
    const key = waitingKey("local", "delayed-send");
    try {
      rememberWaitingSend(key, "delayed", 1);
      const before = currentWaitingSends(key);
      settleWaitingSends(key, []);
      expect(currentWaitingSends(key)).toBe(before);
      expect(currentWaitingSends(key)).toHaveLength(1);
      settleWaitingSends(key, [user("delayed", 10_000)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("never treats an undated or invalidly dated turn as evidence for a new send", () => {
    expect(transcriptHolds(send, [{ ...user(send.text), ts: null }])).toBe(false);
    expect(transcriptHolds(send, [{ ...user(send.text), ts: "invalid" }])).toBe(false);
    expect(transcriptHolds({ ...send, text: "Please review the complete implementation and report issues", at: 10 }, [user("Please review the complete implementation…", 9)])).toBe(false);
  });
});
