import { describe, expect, it } from "bun:test";

import type { RewindPoint } from "../../shared/rewind.ts";
import { rewindChoices, rewindErrorText, rewindWhen } from "./rewindChoices.ts";

const point = (files: number): RewindPoint => ({ message_id: "m", at: "2026-10-20T10:00:00.000Z", prompt: "hello", files });

describe("rewind choices", () => {
  it("offers the conversation alone for a message that changed no file", () => {
    expect(rewindChoices(point(0), "offline")).toEqual([{ restore: "conversation", label: "Restore conversation", primary: true }]);
    expect(rewindChoices(point(0), "terminal")).toEqual([{ restore: "conversation", label: "Restore conversation", primary: true }]);
  });

  it("offers code and conversation first when the message has files", () => {
    const offline = rewindChoices(point(2), "offline");
    expect(offline.map((choice) => choice.restore)).toEqual(["both", "conversation"]);
    expect(offline[0]!.primary).toBe(true);
    // a direct restore has no reason to put files back without the conversation that goes with them
    expect(offline.some((choice) => choice.restore === "code")).toBe(false);
  });

  it("lets a live agent's own dialog offer code alone, since its wording decides", () => {
    const terminal = rewindChoices(point(2), "terminal");
    expect(terminal.map((choice) => choice.restore)).toEqual(["both", "conversation", "code"]);
    expect(terminal[1]!.primary).toBe(false);
  });
});

describe("rewind refusals", () => {
  it("names what a person can act on, and nothing for an unknown code", () => {
    expect(rewindErrorText("rewind_target_mismatch")).toContain("nothing was restored");
    expect(rewindErrorText("rewind_dialog_open")).toContain("already open");
    expect(rewindErrorText("rewind_no_code")).toContain("changed no file");
    expect(rewindErrorText("something_else")).toBe("The rewind did not go through");
  });
});

describe("checkpoint times", () => {
  it("shows the clock for today and a date for anything older", () => {
    const today = new Date(2026, 9, 20, 15, 30);
    const at = new Date(2026, 9, 20, 9, 5).toISOString();
    expect(rewindWhen(at, today.getTime())).toMatch(/09|9/);
    const older = new Date(2026, 9, 18, 9, 5).toISOString();
    expect(rewindWhen(older, today.getTime())).not.toBe(rewindWhen(at, today.getTime()));
  });

  it("says nothing for a time it cannot read", () => {
    expect(rewindWhen("not a date")).toBe("");
  });
});
