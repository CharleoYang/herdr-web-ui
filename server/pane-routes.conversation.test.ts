import { describe, expect, it } from "bun:test";

import { ConversationNotStarted, ConversationUnavailable } from "./conversation.ts";
import { conversationFailure } from "./pane-routes.ts";

/**
 * A session the agent named and has not written yet is not an unavailable conversation: answering
 * `scrollback` there handed a fresh pane to the terminal until the file appeared (a first omp answer
 * can be a minute), which is what the chat showed as "conversation unavailable".
 */
describe("a failed conversation read", () => {
  it("keeps a not yet written transcript as a conversation with no turns", async () => {
    const response = conversationFailure("w1:p1", new ConversationNotStarted("session-id", "omp-transcript"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ source: "omp-transcript", turns: [], session_not_started: true });
  });

  it("names the transcript the pane will have, for every agent that keeps one", () => {
    for (const source of ["omp-transcript", "claude-transcript", "omo-transcript"] as const) {
      const response = conversationFailure("w1:p1", new ConversationNotStarted("session-id", source));
      expect(response.status).toBe(200);
    }
  });

  it("still falls back to the scrollback transcript for a conversation that cannot be read", async () => {
    const response = conversationFailure("w1:p1", new ConversationUnavailable("no_session_path"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { source: string; session_not_started?: true };
    expect(body.source).toBe("scrollback");
    expect(body.session_not_started).toBeUndefined();
  });

  it("keeps the screen's own metadata in that fallback", async () => {
    const response = conversationFailure("w1:p1", new ConversationUnavailable("no_session_path", { model: "Opus 5.5", reasoning_effort: null }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { source: string; screen?: true; metadata?: { model: string | null } };
    expect(body.screen).toBe(true);
    expect(body.metadata?.model).toBe("Opus 5.5");
  });

  it("answers an unexpected failure as one", async () => {
    const response = conversationFailure("w1:p1", new Error("boom"));
    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
