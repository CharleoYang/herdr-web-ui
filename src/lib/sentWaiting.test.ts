import { describe, expect, it } from "bun:test";

import { transcriptHolds, waitingText } from "./sentWaiting.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";

const user = (text: string): Pick<ConversationTurn, "role" | "parts"> => ({ role: "user", parts: [{ kind: "text", text }] as ConversationTurn["parts"] });
const assistant = (text: string): Pick<ConversationTurn, "role" | "parts"> => ({ role: "assistant", parts: [{ kind: "text", text }] as ConversationTurn["parts"] });

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
});
