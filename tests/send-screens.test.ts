import { describe, expect, it } from "vitest";
import { COPY } from "../src/send/copy.js";
import { screenText } from "../src/send/screens.js";
import { INITIAL_STATE, reduce, type ScreenId, type ViewEvent, type ViewState } from "../src/send/state.js";

const run = (events: ViewEvent[], from: ViewState = INITIAL_STATE): ViewState => events.reduce(reduce, from);
const toSending: ViewEvent[] = [
  { type: "continue" },
  { type: "paired", words: "walk art wisdom" },
  { type: "yes" },
  { type: "invitation", maxBytes: 250_000_000, theirHidden: false },
  { type: "asking", name: "holiday.mp4", size: 120_000_000 },
  { type: "linking" },
  { type: "sending", total: 120_588_136 },
];
const text = (events: ViewEvent[]): string => {
  const { h1, body } = screenText(run(events));
  return `${h1} ${body ?? ""}`;
};

// The endings that, before the end of the file is sent, say it was not kept.
const ENDINGS: readonly [ViewEvent["type"], ScreenId][] = [
  ["no-room", "no-room"],
  ["lost", "lost"],
  ["they-stopped", "they-stopped"],
  ["failed", "failed"],
  ["cancel", "cancelled"],
];

describe("what the page says once the end of the file has been sent", () => {
  it.each(ENDINGS)("says on %s that nothing was kept only before the end was sent", (type, screen) => {
    const before = run([...toSending, { type } as ViewEvent]);
    expect(before.screen).toBe(screen);
    expect(screenText(before).body ?? "").toMatch(/nothing was kept/iu);
    expect(screenText(before).body ?? "").not.toMatch(/may have reached/iu);
  });

  it.each(ENDINGS)("never says nothing was kept after the end was sent, whatever the ending: %s", (type, screen) => {
    const after = run([...toSending, { type: "end-sent" }, { type } as ViewEvent]);
    expect(after.screen).toBe(screen);
    const { h1, body } = screenText(after);
    expect(`${h1} ${body}`).not.toMatch(/nothing was (?:kept|sent)|not kept|wasn't kept|was not sent/iu);
    expect(body).toBe("It may have reached them. Check with them.");
  });

  it("names the outcome as unknown for every ending the copy file has an after-end version of", () => {
    for (const [key, entry] of Object.entries(COPY.screens.afterEnd)) {
      expect(entry.body, key).toMatch(/may have reached them/u);
      expect(`${entry.h1} ${entry.body}`, key).not.toMatch(/nothing was/iu);
    }
    expect(Object.keys(COPY.screens.afterEnd).sort()).toEqual(["cancelled", "failed", "lost", "noRoom", "theyStopped"]);
  });

  it("keeps each heading, so the person still sees what happened", () => {
    expect(screenText(run([...toSending, { type: "end-sent" }, { type: "lost" }])).h1).toBe(COPY.screens.lost.h1);
    expect(screenText(run([...toSending, { type: "end-sent" }, { type: "they-stopped" }])).h1).toBe(COPY.screens.theyStopped.h1);
    expect(screenText(run([...toSending, { type: "end-sent" }, { type: "cancel" }])).h1).toBe(COPY.screens.cancelled.h1);
  });

  it("shows a finishing screen that says it is waiting for them, not that it arrived", () => {
    const finishing = screenText(run([...toSending, { type: "end-sent" }]));
    expect(finishing.h1).toBe("Finishing…");
    expect(finishing.body).toMatch(/waiting for them/iu);
    expect(`${finishing.h1} ${finishing.body}`).not.toMatch(/\bsent\b|has (?:reached|arrived)|is on their/iu);
    // And "Sent" appears only on the receiver's word.
    expect(text([...toSending, { type: "end-sent" }, { type: "sent" }])).toMatch(/^Sent /u);
  });

  it("does not change an ending that cannot come after the end", () => {
    expect(screenText(run([...toSending, { type: "no-relay" }])).h1).toBe(COPY.screens.cannotHide.h1);
    expect(screenText(run([...toSending, { type: "connect-failed" }])).h1).toBe(COPY.screens.connectFailed.h1);
    expect(text([{ type: "continue" }, { type: "wrong-words" }])).toContain("Those words didn't work");
  });
});
