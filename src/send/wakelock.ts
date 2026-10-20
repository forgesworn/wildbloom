/**
 * Keeps the phone's screen on while a file is being locked and sent, where the
 * browser supports it, because a screen that turns off stops the upload. It is
 * a request the browser may refuse (low battery, a policy, an old browser), and
 * nothing depends on it: the page says to keep it open either way.
 */

interface SentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

interface WakeLockLike {
  request(type: "screen"): Promise<SentinelLike>;
}

/** The part of `document` the lock watches: whether the page is showing, and when that changes. */
interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface ScreenLock {
  /** Starts asking for the screen to stay on. Safe to repeat. */
  hold(): void;
  /** Lets the screen sleep again. Safe to repeat. */
  release(): void;
}

export function createScreenLock(
  wakeLock: WakeLockLike | undefined = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock,
  visibility: VisibilitySource = document,
): ScreenLock {
  let wanted = false;
  let sentinel: SentinelLike | undefined;
  let pending = false;

  const acquire = async (): Promise<void> => {
    if (!wakeLock || !wanted || sentinel || pending) return;
    pending = true;
    try {
      const granted = await wakeLock.request("screen");
      if (wanted) {
        sentinel = granted;
        // The browser drops the lock when the page is hidden; forget it so a return asks again.
        granted.addEventListener?.("release", () => { if (sentinel === granted) sentinel = undefined; });
      } else {
        await granted.release().catch(() => undefined);
      }
    } catch {
      // Refused or unsupported: carry on without it.
    } finally {
      pending = false;
    }
  };

  const onVisible = (): void => {
    if (visibility.visibilityState === "visible") void acquire();
  };

  return {
    hold(): void {
      if (wanted) return;
      wanted = true;
      visibility.addEventListener("visibilitychange", onVisible);
      void acquire();
    },
    release(): void {
      if (!wanted) return;
      wanted = false;
      visibility.removeEventListener("visibilitychange", onVisible);
      const held = sentinel;
      sentinel = undefined;
      void held?.release().catch(() => undefined);
    },
  };
}
