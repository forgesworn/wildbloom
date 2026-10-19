import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reduce, type ScreenId, type ViewEvent, type ViewState } from "../src/send/state.js";

function run(events: ViewEvent[], from: ViewState = INITIAL_STATE): ViewState {
  return events.reduce(reduce, from);
}

const toCheck: ViewEvent[] = [{ type: "continue" }, { type: "paired", words: "walk art wisdom" }];
const toChoose: ViewEvent[] = [...toCheck, { type: "yes" }, { type: "invitation", maxBytes: 250_000_000 }];
const toSending: ViewEvent[] = [...toChoose, { type: "preparing", name: "holiday.mp4" }, { type: "sending", total: 210_000_000 }];

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
    for (const event of [
      ...toSending,
      { type: "progress", sent: 45_000_000 },
      { type: "sent" },
    ] as ViewEvent[]) {
      state = reduce(state, event);
      screens.push(state.screen);
    }
    expect(screens).toEqual(["connecting", "check", "confirming", "choose", "preparing", "sending", "sending", "sent"]);
    expect(state.fileName).toBe("holiday.mp4");
    expect(state.sent).toBe(45_000_000);
    expect(state.maxBytes).toBe(250_000_000);
  });

  it("keeps the check words only while they are being compared", () => {
    const checking = run(toCheck);
    expect(checking.checkWords).toBe("walk art wisdom");
    expect(run([{ type: "no" }], checking)).toMatchObject({ screen: "mismatch", checkWords: "" });
    expect(run([{ type: "yes" }, { type: "invitation", maxBytes: 1 }], checking).checkWords).toBe("");
  });

  it("moves to a slow-them notice only while connecting", () => {
    expect(run([{ type: "continue" }, { type: "slow" }]).screen).toBe("waiting");
    expect(run([{ type: "slow" }]).screen).toBe("words");
    expect(run([...toCheck, { type: "slow" }]).screen).toBe("check");
  });

  it("ends the attempt on wrong words, a refused claim or a lost connection", () => {
    expect(run([{ type: "continue" }, { type: "wrong-words" }]).screen).toBe("wrong-words");
    expect(run([{ type: "continue" }, { type: "slow" }, { type: "wrong-words" }]).screen).toBe("wrong-words");
    expect(run([{ type: "continue" }, { type: "claim-refused" }]).screen).toBe("used");
    expect(run([{ type: "continue" }, { type: "network" }]).screen).toBe("network");
    expect(run([{ type: "continue" }, { type: "network" }, { type: "continue" }]).screen).toBe("connecting");
  });

  it("cancels back to the words before a claim and to a stop screen after one", () => {
    expect(run([{ type: "continue" }, { type: "back" }]).screen).toBe("words");
    expect(run([{ type: "continue" }, { type: "slow" }, { type: "cancel" }]).screen).toBe("cancelled");
    expect(run([...toCheck, { type: "yes" }, { type: "cancel" }]).screen).toBe("cancelled");
  });

  it("sends a link that runs out before the invitation to the expired screen, and never afterwards", () => {
    for (const events of [[], [{ type: "continue" }], toCheck, [...toCheck, { type: "yes" }]] as ViewEvent[][]) {
      expect(run([{ type: "expired" }], run(events)).screen).toBe("expired");
    }
    // After the invitation the link no longer matters: only the grant's own end does.
    expect(run([{ type: "expired" }], run(toChoose)).screen).toBe("choose");
    expect(run([{ type: "expired" }], run(toSending)).screen).toBe("sending");
  });

  it("maps an unusable invitation to its screen, and a grant that has run out to ended", () => {
    const waiting = run([...toCheck, { type: "yes" }]);
    expect(run([{ type: "invalid-invitation" }], waiting).screen).toBe("invalid");
    expect(run([{ type: "ended" }], waiting).screen).toBe("ended");
  });

  it("refuses a file that is too big or empty, and lets the person choose again", () => {
    const choosing = run(toChoose);
    expect(run([{ type: "too-big" }], choosing).screen).toBe("too-big");
    expect(run([{ type: "empty" }], choosing).screen).toBe("empty");
    expect(run([{ type: "empty" }, { type: "too-big" }], choosing).screen).toBe("too-big");
    expect(run([{ type: "too-big" }, { type: "again" }], choosing).screen).toBe("choose");
    expect(run([{ type: "too-big" }, { type: "preparing", name: "small.txt" }], choosing).screen).toBe("preparing");
    expect(run([{ type: "too-big" }], choosing).maxBytes).toBe(250_000_000);
  });

  it("takes a file only from a screen where one can be picked", () => {
    expect(run([{ type: "preparing", name: "x" }]).screen).toBe("words");
    expect(run([{ type: "preparing", name: "x" }], run(toSending)).screen).toBe("sending");
    expect(run([{ type: "too-big" }], run(toSending)).screen).toBe("sending");
  });

  it("moves from preparing to sending, and reports an unreadable file", () => {
    const preparing = run([...toChoose, { type: "preparing", name: "holiday.mp4" }]);
    expect(preparing.screen).toBe("preparing");
    expect(run([{ type: "unreadable" }], preparing).screen).toBe("unreadable");
    expect(run([{ type: "unreadable" }, { type: "again" }], preparing).screen).toBe("choose");
    expect(run([{ type: "sending", total: 5 }], preparing)).toMatchObject({ screen: "sending", total: 5, sent: 0 });
  });

  it("tracks progress and the wait before an automatic retry without changing screen", () => {
    const sending = run(toSending);
    const halfway = run([{ type: "progress", sent: 100 }, { type: "retrying", on: true }], sending);
    expect(halfway).toMatchObject({ screen: "sending", sent: 0, retrying: true });
    expect(run([{ type: "progress", sent: 100 }], sending)).toMatchObject({ sent: 100, retrying: false });
    expect(run([{ type: "progress", sent: 200 }], halfway)).toMatchObject({ sent: 200, retrying: false });
    const choosing = run(toChoose);
    expect(run([{ type: "progress", sent: 5 }], choosing)).toBe(choosing);
    expect(run([{ type: "retrying", on: true }], choosing)).toBe(choosing);
  });

  it("stops with a way to try again, and restarts the count", () => {
    const stopped = run([{ type: "progress", sent: 70 }, { type: "retrying", on: true }, { type: "stopped" }], run(toSending));
    expect(stopped).toMatchObject({ screen: "stopped", retrying: false, clockHint: false });
    expect(run([{ type: "sending", total: 210_000_000 }], stopped)).toMatchObject({ screen: "sending", sent: 0, retrying: false });
    expect(run([{ type: "stopped", clockHint: true }], run(toSending)).clockHint).toBe(true);
    expect(run([{ type: "sending", total: 1 }], run([{ type: "stopped", clockHint: true }], run(toSending))).clockHint).toBe(false);
  });

  it("ends the request from any screen where it is still open, and from sending when the node says so", () => {
    for (const screen of [run(toChoose), run([...toChoose, { type: "preparing", name: "a" }]), run([{ type: "stopped" }], run(toSending)), run(toSending)]) {
      expect(run([{ type: "ended" }], screen).screen).toBe("ended");
    }
    expect(run([{ type: "ended" }], run([{ type: "sent" }], run(toSending))).screen).toBe("sent");
    expect(run([{ type: "ended" }]).screen).toBe("words");
  });

  it("says the storage has no room only while a file is going", () => {
    expect(run([{ type: "no-room" }], run(toSending)).screen).toBe("no-room");
    expect(run([{ type: "no-room" }], run(toChoose)).screen).toBe("choose");
    expect(run([{ type: "no-room" }, { type: "again" }], run(toSending)).screen).toBe("choose");
  });

  it("tracks online status without changing screen", () => {
    const offline = run([{ type: "online", online: false }]);
    expect(offline).toMatchObject({ screen: "words", offline: true });
    expect(run([{ type: "online", online: false }], offline)).toBe(offline);
    expect(run([{ type: "online", online: true }], offline).offline).toBe(false);
  });

  it("ignores an event that does not apply", () => {
    expect(run([{ type: "yes" }])).toBe(INITIAL_STATE);
    expect(run([{ type: "sent" }])).toBe(INITIAL_STATE);
    expect(run([{ type: "invitation", maxBytes: 5 }])).toBe(INITIAL_STATE);
    expect(run([{ type: "invalid-invitation" }])).toBe(INITIAL_STATE);
    expect(run([{ type: "again" }])).toBe(INITIAL_STATE);
  });
});
