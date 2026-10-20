import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reduce, type ScreenId, type ViewEvent, type ViewState } from "../src/send/state.js";

function run(events: ViewEvent[], from: ViewState = INITIAL_STATE): ViewState {
  return events.reduce(reduce, from);
}

const toCheck: ViewEvent[] = [{ type: "continue" }, { type: "paired", words: "walk art wisdom" }];
const toChoose: ViewEvent[] = [...toCheck, { type: "yes" }, { type: "invitation", maxBytes: 250_000_000, theirHidden: true }];
const toAsking: ViewEvent[] = [...toChoose, { type: "asking", name: "holiday.mp4", size: 120_000_000 }];
const toSending: ViewEvent[] = [...toAsking, { type: "linking" }, { type: "sending", total: 120_588_136 }];

describe("sender state reducer", () => {
  it("starts on the words screen and routes bad links without touching a good one", () => {
    expect(INITIAL_STATE.screen).toBe("words");
    expect(run([{ type: "start", link: "ok" }]).screen).toBe("words");
    expect(run([{ type: "start", link: "missing" }]).screen).toBe("incomplete");
    expect(run([{ type: "start", link: "invalid" }]).screen).toBe("incomplete");
    expect(run([{ type: "start", link: "expired" }]).screen).toBe("expired");
    expect(run([{ type: "unsupported" }]).screen).toBe("unsupported");
  });

  it("walks the happy path from words to sent", () => {
    const screens: ScreenId[] = [];
    let state = INITIAL_STATE;
    for (const event of [...toSending, { type: "progress", sent: 45_000_000 }, { type: "sent" }] as ViewEvent[]) {
      state = reduce(state, event);
      screens.push(state.screen);
    }
    expect(screens).toEqual(["connecting", "check", "confirming", "choose", "asking", "linking", "sending", "sending", "sent"]);
    expect(state.fileName).toBe("holiday.mp4");
    expect(state.fileSize).toBe(120_000_000);
    expect(state.sent).toBe(45_000_000);
    expect(state.maxBytes).toBe(250_000_000);
    expect(state.theirHidden).toBe(true);
  });

  it("goes straight from asking to sending when the path is found at once", () => {
    expect(run([...toAsking, { type: "sending", total: 100 }]).screen).toBe("sending");
  });

  it("keeps the check words only while they are being compared", () => {
    const checking = run(toCheck);
    expect(checking.checkWords).toBe("walk art wisdom");
    expect(run([{ type: "no" }], checking)).toMatchObject({ screen: "mismatch", checkWords: "" });
    expect(run([{ type: "yes" }, { type: "invitation", maxBytes: 1, theirHidden: false }], checking).checkWords).toBe("");
  });

  it("moves to a slow-them notice only while connecting", () => {
    expect(run([{ type: "continue" }, { type: "slow" }]).screen).toBe("waiting");
    expect(run([{ type: "slow" }]).screen).toBe("words");
    expect(run([...toCheck, { type: "slow" }]).screen).toBe("check");
  });

  it("ends the attempt on wrong words, a refused claim, and offers Try again only for a network problem", () => {
    expect(run([{ type: "continue" }, { type: "wrong-words" }]).screen).toBe("wrong-words");
    expect(run([{ type: "continue" }, { type: "claim-refused" }]).screen).toBe("used");
    expect(run([{ type: "continue" }, { type: "network" }]).screen).toBe("network");
    expect(run([{ type: "continue" }, { type: "network" }, { type: "continue" }]).screen).toBe("connecting");
    // Once the words are accepted a network problem is a lost session, not a retry.
    expect(run([...toCheck, { type: "network" }]).screen).toBe("check");
  });

  it("cancels back to the words before a claim and to a stop screen after one", () => {
    expect(run([{ type: "continue" }, { type: "back" }]).screen).toBe("words");
    expect(run([...toCheck, { type: "cancel" }]).screen).toBe("check");
    for (const events of [[{ type: "continue" }], [...toCheck, { type: "yes" }], toChoose, [...toChoose, { type: "empty" }], toAsking, toSending, [...toSending, { type: "end-sent" }]] as ViewEvent[][]) {
      expect(run([...events, { type: "cancel" }]).screen).toBe("cancelled");
    }
  });

  it("reports a file that is empty, too big or unreadable and lets another be chosen", () => {
    for (const type of ["too-big", "empty", "unreadable"] as const) {
      const refused = run([...toChoose, { type }]);
      expect(refused.screen).toBe(type);
      expect(run([{ type: "asking", name: "again.bin", size: 5 }], refused).screen).toBe("asking");
    }
    expect(run([{ type: "too-big" }]).screen).toBe("words");
  });

  it("remembers the hide option across screens", () => {
    const hidden = run([...toChoose, { type: "hide", on: true }, { type: "too-big" }]);
    expect(hidden.hide).toBe(true);
    expect(run([{ type: "hide", on: false }], hidden).hide).toBe(false);
    expect(run([{ type: "hide", on: true }], hidden)).toBe(hidden);
  });

  it("follows the owner's decision", () => {
    expect(run([...toAsking, { type: "declined" }]).screen).toBe("declined");
    expect(run([...toChoose, { type: "declined" }]).screen).toBe("choose");
  });

  it("shows a dropped connection without leaving the sending screen, and clears it when it returns", () => {
    const dropped = run([...toSending, { type: "progress", sent: 10 }, { type: "reconnecting", on: true }]);
    expect(dropped).toMatchObject({ screen: "sending", reconnecting: true, sent: 10 });
    expect(run([{ type: "reconnecting", on: false }], dropped).reconnecting).toBe(false);
    expect(run([{ type: "reconnecting", on: true }], dropped)).toBe(dropped);
    expect(run([{ type: "reconnecting", on: true }])).toBe(INITIAL_STATE);
  });

  it.each(["no-relay", "no-room", "connect-failed", "lost", "they-stopped", "failed"] as const)("ends on %s from any step after the file was offered", (type) => {
    for (const events of [toAsking, [...toAsking, { type: "linking" }], toSending, [...toSending, { type: "end-sent" }]] as ViewEvent[][]) {
      expect(run([...events, { type }]).screen).toBe(type);
    }
    expect(run([{ type }]).screen).toBe("words");
  });

  it("moves to finishing when the end of the file is sent, and to sent only on the receiver's word", () => {
    const finishing = run([...toSending, { type: "end-sent" }]);
    expect(finishing).toMatchObject({ screen: "finishing", endSent: true });
    // Progress after the end is not shown, and the screen does not slide back.
    expect(run([{ type: "progress", sent: 5 }], finishing)).toBe(finishing);
    expect(run([{ type: "sent" }], finishing).screen).toBe("sent");
    // The end can only be sent while sending.
    expect(run([{ type: "end-sent" }])).toBe(INITIAL_STATE);
    expect(run([...toAsking, { type: "end-sent" }]).screen).toBe("asking");
    expect(run([...toAsking, { type: "linking" }, { type: "end-sent" }]).screen).toBe("linking");
    expect(run([{ type: "end-sent" }], run([...toSending, { type: "sent" }])).screen).toBe("sent");
  });

  it("shows a dropped connection while finishing", () => {
    const finishing = run([...toSending, { type: "end-sent" }]);
    expect(run([{ type: "reconnecting", on: true }], finishing)).toMatchObject({ screen: "finishing", reconnecting: true });
  });

  it.each(["no-room", "lost", "they-stopped", "failed", "cancel"] as const)("remembers that the end was sent when it ends on %s", (type) => {
    const ended = run([...toSending, { type: "end-sent" }, { type }]);
    expect(ended.screen).toBe(type === "cancel" ? "cancelled" : type);
    expect(ended.endSent).toBe(true);
    // An ending before the end was sent says the opposite.
    expect(run([...toSending, { type }]).endSent).toBe(false);
  });

  it("forgets that the end was sent when another file is offered", () => {
    // Only a file offered afresh, from a screen where one can be chosen, starts the record again.
    const picking = { ...run(toChoose), endSent: true };
    expect(run([{ type: "asking", name: "again.bin", size: 5 }], picking).endSent).toBe(false);
    expect(run([{ type: "asking", name: "again.bin", size: 5 }], run([...toSending, { type: "end-sent" }, { type: "lost" }])).screen).toBe("lost");
  });

  it("treats a lost or stopped session before the file was offered as an end too", () => {
    for (const type of ["lost", "they-stopped", "failed"] as const) {
      expect(run([...toChoose, { type }]).screen).toBe(type);
      expect(run([...toCheck, { type: "yes" }, { type }]).screen).toBe(type);
    }
  });

  it("never lets a finished screen move", () => {
    const sent = run([...toSending, { type: "sent" }]);
    for (const type of ["lost", "cancel", "declined", "progress", "expired", "failed", "end-sent"] as const) {
      expect(run([{ type, sent: 1 } as ViewEvent], sent)).toBe(sent);
    }
  });

  it("runs out of time on the screens before the file moves, and not after", () => {
    for (const events of [[], [{ type: "continue" }], toCheck, toChoose, [...toChoose, { type: "empty" }], toAsking] as ViewEvent[][]) {
      expect(run([...events, { type: "expired" }]).screen).toBe("expired");
    }
    expect(run([...toSending, { type: "expired" }]).screen).toBe("sending");
  });

  it("treats an unusable invitation as its own ending", () => {
    expect(run([...toCheck, { type: "yes" }, { type: "invalid-invitation" }]).screen).toBe("invalid");
    expect(run([...toChoose, { type: "invalid-invitation" }]).screen).toBe("choose");
  });

  it("tracks the offline banner without changing screen", () => {
    const offline = run([{ type: "online", online: false }]);
    expect(offline).toMatchObject({ screen: "words", offline: true });
    expect(run([{ type: "online", online: false }], offline)).toBe(offline);
    expect(run([{ type: "online", online: true }], offline).offline).toBe(false);
  });
});
