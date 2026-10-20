import { describe, expect, it, vi } from "vitest";
import { createScreenLock } from "../src/send/wakelock.js";

function fakes() {
  const listeners = new Map<string, () => void>();
  const releaseListeners: (() => void)[] = [];
  let state = "visible";
  const sentinels: { release: ReturnType<typeof vi.fn> }[] = [];
  const wakeLock = {
    request: vi.fn(async () => {
      const sentinel = {
        release: vi.fn(() => Promise.resolve()),
        addEventListener: (_type: "release", listener: () => void) => { releaseListeners.push(listener); },
      };
      sentinels.push(sentinel);
      return sentinel;
    }),
  };
  const visibility = {
    get visibilityState() { return state; },
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  return {
    wakeLock,
    visibility,
    sentinels,
    listeners,
    releaseListeners,
    show: (next: string) => { state = next; listeners.get("visibilitychange")?.(); },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the screen lock", () => {
  it("asks once, and lets go when told", async () => {
    const { wakeLock, visibility, sentinels } = fakes();
    const lock = createScreenLock(wakeLock, visibility);
    lock.hold();
    lock.hold();
    await settle();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    lock.release();
    await settle();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
    lock.release();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });

  it("asks again when the page comes back, because the browser drops the lock when it is hidden", async () => {
    const { wakeLock, visibility, releaseListeners, show } = fakes();
    const lock = createScreenLock(wakeLock, visibility);
    lock.hold();
    await settle();
    show("hidden");
    releaseListeners.forEach((listener) => listener());
    show("visible");
    await settle();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it("does not ask again once released, even if the page returns", async () => {
    const { wakeLock, visibility, listeners, show } = fakes();
    const lock = createScreenLock(wakeLock, visibility);
    lock.hold();
    await settle();
    lock.release();
    expect(listeners.size).toBe(0);
    show("visible");
    await settle();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
  });

  it("carries on when the browser refuses or has no wake lock", async () => {
    const refusing = { request: vi.fn(() => Promise.reject(new DOMException("denied", "NotAllowedError"))) };
    const { visibility } = fakes();
    const lock = createScreenLock(refusing, visibility);
    expect(() => lock.hold()).not.toThrow();
    await settle();
    expect(() => lock.release()).not.toThrow();
    const none = createScreenLock(undefined, visibility);
    expect(() => { none.hold(); none.release(); }).not.toThrow();
  });

  it("gives the lock straight back if it was released while the browser was still deciding", async () => {
    const { visibility, sentinels } = fakes();
    let grant: (() => void) | undefined;
    const slow = {
      request: vi.fn(() => new Promise<{ release: () => Promise<void> }>((resolve) => {
        grant = () => {
          const sentinel = { release: vi.fn(() => Promise.resolve()) };
          sentinels.push(sentinel);
          resolve(sentinel);
        };
      })),
    };
    const lock = createScreenLock(slow, visibility);
    lock.hold();
    lock.release();
    grant?.();
    await settle();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });
});
