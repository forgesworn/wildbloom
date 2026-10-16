import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reduce, type ViewEvent, type ViewState } from "../src/get/state.js";

function run(events: ViewEvent[], from: ViewState = INITIAL_STATE): ViewState {
  return events.reduce(reduce, from);
}

const toCheckWords: ViewEvent[] = [{ type: "continue" }, { type: "paired", words: "walk art wisdom" }];
const toReady: ViewEvent[] = [...toCheckWords, { type: "yes" }, { type: "details", name: "photos.zip", size: 24_300_000 }];

describe("recipient state reducer", () => {
  it("starts on the words screen and routes bad links without touching a good one", () => {
    expect(INITIAL_STATE.screen).toBe("r5");
    expect(run([{ type: "start", link: "ok" }]).screen).toBe("r5");
    expect(run([{ type: "start", link: "missing" }]).screen).toBe("r3");
    expect(run([{ type: "start", link: "invalid" }]).screen).toBe("r3");
    expect(run([{ type: "start", link: "expired" }]).screen).toBe("r4");
    expect(run([{ type: "unsupported" }]).screen).toBe("r2");
  });

  it("walks the happy path from words to saved", () => {
    const screens: string[] = [];
    let state = INITIAL_STATE;
    for (const event of [
      ...toReady,
      { type: "download" },
      { type: "progress", received: 1_000 },
      { type: "checking" },
      { type: "saved" },
    ] as ViewEvent[]) {
      state = reduce(state, event);
      screens.push(state.screen);
    }
    expect(screens).toEqual(["r6", "r12", "r14", "r15", "r16", "r16", "r17", "r18"]);
    expect(state.fileName).toBe("photos.zip");
  });

  it("keeps the check words only while they are being compared", () => {
    const checking = run(toCheckWords);
    expect(checking.checkWords).toBe("walk art wisdom");
    expect(run([{ type: "no" }], checking)).toMatchObject({ screen: "r13", checkWords: "" });
    expect(run([{ type: "yes" }, { type: "details", name: "a", size: 1 }], checking).checkWords).toBe("");
  });

  it("moves to a slow-sender notice only while connecting", () => {
    expect(run([{ type: "continue" }, { type: "slow" }]).screen).toBe("r7");
    expect(run([{ type: "slow" }]).screen).toBe("r5");
    expect(run([...toCheckWords, { type: "slow" }]).screen).toBe("r12");
  });

  it("ends the attempt on wrong words, a refused claim or a lost connection", () => {
    expect(run([{ type: "continue" }, { type: "wrong-words" }]).screen).toBe("r8");
    expect(run([{ type: "continue" }, { type: "slow" }, { type: "wrong-words" }]).screen).toBe("r8");
    expect(run([{ type: "continue" }, { type: "claim-refused" }]).screen).toBe("r9");
    expect(run([{ type: "continue" }, { type: "network" }]).screen).toBe("r10");
    expect(run([{ type: "continue" }, { type: "network" }, { type: "continue" }]).screen).toBe("r6");
  });

  it("cancels back to the words before a claim and to a stop screen after one", () => {
    expect(run([{ type: "continue" }, { type: "back" }]).screen).toBe("r5");
    expect(run([{ type: "continue" }, { type: "slow" }, { type: "cancel" }]).screen).toBe("cancelled");
    expect(run([...toCheckWords, { type: "yes" }, { type: "cancel" }]).screen).toBe("cancelled");
  });

  it("returns a cancelled download to the ready screen", () => {
    expect(run([...toReady, { type: "download" }, { type: "cancel" }]).screen).toBe("r15");
  });

  it("maps descriptor problems and oversize files to their screens", () => {
    const waiting = run([...toCheckWords, { type: "yes" }]);
    expect(run([{ type: "invalid-details" }], waiting).screen).toBe("invalid");
    expect(run([{ type: "too-big" }], waiting).screen).toBe("r22");
  });

  it("classifies download failures and allows a retry from the retryable ones", () => {
    const downloading = run([...toReady, { type: "download" }]);
    expect(run([{ type: "missing" }], downloading).screen).toBe("r20");
    expect(run([{ type: "unavailable" }], downloading).screen).toBe("r19");
    expect(run([{ type: "damaged" }], downloading).screen).toBe("r21");
    expect(run([{ type: "unavailable" }, { type: "download" }], downloading).screen).toBe("r16");
    expect(run([{ type: "damaged" }, { type: "download" }], downloading).screen).toBe("r16");
    expect(run([{ type: "missing" }, { type: "download" }], downloading).screen).toBe("r20");
    const checking = run([{ type: "checking" }], downloading);
    expect(run([{ type: "damaged" }], checking).screen).toBe("r21");
  });

  it("handles a save that did not happen and a second try", () => {
    const checking = run([...toReady, { type: "download" }, { type: "checking" }]);
    const failed = run([{ type: "save-failed" }], checking);
    expect(failed.screen).toBe("r23");
    expect(run([{ type: "save-again" }], failed).screen).toBe("r18");
    expect(run([{ type: "save-failed" }], run([{ type: "saved" }], checking)).screen).toBe("r23");
  });

  it("lets the link run out while words, pairing or check words are on screen, but not after the file is in hand", () => {
    for (const events of [[], [{ type: "continue" }], toCheckWords, [...toCheckWords, { type: "yes" }]] as ViewEvent[][]) {
      expect(run([...events, { type: "expired" }]).screen).toBe("r4");
    }
    expect(run([...toReady, { type: "expired" }]).screen).toBe("r15");
  });

  it("tracks the offline flag and ignores a repeat", () => {
    const offline = run([{ type: "online", online: false }]);
    expect(offline.offline).toBe(true);
    expect(reduce(offline, { type: "online", online: false })).toBe(offline);
    expect(reduce(offline, { type: "online", online: true }).offline).toBe(false);
  });

  it("ignores events that do not apply to the current screen", () => {
    expect(run([{ type: "yes" }])).toBe(INITIAL_STATE);
    expect(run([{ type: "download" }])).toBe(INITIAL_STATE);
    expect(run([{ type: "saved" }])).toBe(INITIAL_STATE);
    expect(run([{ type: "wrong-words" }])).toBe(INITIAL_STATE);
    const done = run([...toReady, { type: "download" }, { type: "checking" }, { type: "saved" }]);
    expect(run([{ type: "continue" }, { type: "paired", words: "x" }, { type: "no" }], done)).toBe(done);
  });
});
