import { sha256Hex } from "./crypto.js";
import { safeDiagnostic } from "./security.js";
import type { InspectedFile, NetworkProfile, ResolvedHybridEvent, StopHandle, TorrentPlan } from "./types.js";

const SWARM_TIMEOUT_MS = 30 * 60 * 1000;
const SWARM_START_TIMEOUT_MS = 30_000;
const CLIENT_DESTROY_TIMEOUT_MS = 5_000;
function privateWebTorrentClientOptions() {
  // WebTorrent otherwise inherits public Google and Twilio STUN servers from
  // simple-peer. Wildbloom never contacts undeclared ICE infrastructure. This
  // host-candidate-only policy is intentionally conservative: cross-network
  // connectivity needs a separately reviewed, explicitly configured service.
  return {
    tracker: { rtcConfig: { iceServers: [] } },
    dht: false,
    lsd: false,
    natPmp: false,
    natUpnp: false,
    utp: false,
  };
}
type WebTorrentConstructor = typeof import("webtorrent/dist/webtorrent.min.js")["default"];
export type WebTorrentLoader = () => Promise<{ default: WebTorrentConstructor }>;
type WebTorrentModule = { default: WebTorrentConstructor };

export async function withBlockedPersistentDebug<T>(
  loader: () => Promise<T>,
  storageConstructor: { prototype: Storage } | undefined,
  getOriginStorage: () => Storage,
): Promise<T> {
  if (!storageConstructor) return loader();
  let originStorage: Storage;
  try {
    originStorage = getOriginStorage();
  } catch {
    // WebTorrent's debug helper also tolerates an origin where local storage is
    // unavailable, so there is no stored debug preference to isolate here.
    return loader();
  }

  const descriptors = new Map(["getItem", "setItem", "removeItem", "clear"].map((method) => [
    method,
    Object.getOwnPropertyDescriptor(storageConstructor.prototype, method),
  ]));
  if ([...descriptors.values()].some((descriptor) => !descriptor
    || typeof descriptor.value !== "function"
    || !descriptor.configurable)) {
    throw new Error("WebTorrent cannot be isolated from persistent browser state.");
  }
  const getItemDescriptor = descriptors.get("getItem")!;
  const setItemDescriptor = descriptors.get("setItem")!;
  const removeItemDescriptor = descriptors.get("removeItem")!;
  const clearDescriptor = descriptors.get("clear")!;
  const nativeGetItem = getItemDescriptor.value as Storage["getItem"];
  const nativeSetItem = setItemDescriptor.value as Storage["setItem"];
  const nativeRemoveItem = removeItemDescriptor.value as Storage["removeItem"];
  const nativeClear = clearDescriptor.value as Storage["clear"];
  const isDebugKey = (key: string): boolean => key === "debug" || key === "DEBUG";
  let unexpectedMutation: string | undefined;
  try {
    Object.defineProperty(storageConstructor.prototype, "getItem", {
      ...getItemDescriptor,
      value(this: Storage, key: string): string | null {
        if (this === originStorage && isDebugKey(key)) return null;
        return nativeGetItem.call(this, key);
      },
    });
    Object.defineProperty(storageConstructor.prototype, "setItem", {
      ...setItemDescriptor,
      value(this: Storage, key: string, value: string): void {
        if (this !== originStorage) return nativeSetItem.call(this, key, value);
        if (!isDebugKey(key)) {
          unexpectedMutation = "write";
          throw new Error("WebTorrent attempted an unexpected persistent browser write.");
        }
      },
    });
    Object.defineProperty(storageConstructor.prototype, "removeItem", {
      ...removeItemDescriptor,
      value(this: Storage, key: string): void {
        if (this !== originStorage) return nativeRemoveItem.call(this, key);
        if (!isDebugKey(key)) {
          unexpectedMutation = "removal";
          throw new Error("WebTorrent attempted an unexpected persistent browser removal.");
        }
      },
    });
    Object.defineProperty(storageConstructor.prototype, "clear", {
      ...clearDescriptor,
      value(this: Storage): void {
        if (this === originStorage) {
          unexpectedMutation = "clear";
          throw new Error("WebTorrent attempted to clear persistent browser state.");
        }
        return nativeClear.call(this);
      },
    });
    const module = await loader();
    if (unexpectedMutation) throw new Error(`WebTorrent attempted an unexpected persistent browser ${unexpectedMutation}.`);
    return module;
  } finally {
    for (const [method, descriptor] of descriptors) {
      Object.defineProperty(storageConstructor.prototype, method, descriptor!);
    }
  }
}

export async function importWebTorrentWithoutStoredDebug(
  loader: () => Promise<WebTorrentModule> = () => import("webtorrent/dist/webtorrent.min.js"),
): Promise<WebTorrentModule> {
  return withBlockedPersistentDebug(
    loader,
    typeof Storage === "undefined" ? undefined : Storage,
    () => globalThis.localStorage,
  );
}

export function createWebTorrentLoader(
  importer: () => Promise<WebTorrentModule> = importWebTorrentWithoutStoredDebug,
): WebTorrentLoader {
  let webTorrentModulePromise: Promise<WebTorrentModule> | undefined;
  return () => {
    webTorrentModulePromise ??= importer().catch((error: unknown) => {
      webTorrentModulePromise = undefined;
      throw error;
    });
    return webTorrentModulePromise;
  };
}

const loadWebTorrent = createWebTorrentLoader();

async function destroyClient(client: { destroy(callback?: (error?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(safeDiagnostic(error)));
      else resolve();
    };
    const timer = globalThis.setTimeout(
      () => finish(new Error("WebTorrent client cleanup timed out.")),
      CLIENT_DESTROY_TIMEOUT_MS,
    );
    try {
      client.destroy((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function cleanupFailure(operation: unknown, cleanup: unknown): Error {
  const operationMessage = operation instanceof Error ? operation.message : safeDiagnostic(operation);
  return new Error(`${operationMessage} WebTorrent cleanup failed: ${safeDiagnostic(cleanup)}`);
}

function clientStopHandle(client: { destroy(callback?: (error?: Error) => void): void }): StopHandle {
  let stopping: Promise<void> | undefined;
  return {
    stop: () => {
      stopping ??= destroyClient(client);
      return stopping;
    },
  };
}

export async function startBrowserSeeding(
  inspected: InspectedFile,
  plan: TorrentPlan,
  profile: NetworkProfile = "direct",
  loader: WebTorrentLoader = loadWebTorrent,
  signal?: AbortSignal,
): Promise<StopHandle> {
  if (profile === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  if (signal?.aborted) throw new Error("WebTorrent seeding cancelled.");
  const { default: WebTorrent } = await loader();
  if (signal?.aborted) throw new Error("WebTorrent seeding cancelled.");
  const client = new WebTorrent(privateWebTorrentClientOptions());
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectAfterDestroy = (error: unknown): void => {
      void destroyClient(client).then(
        () => reject(error instanceof Error ? error : new Error(safeDiagnostic(error))),
        (cleanup) => reject(cleanupFailure(error, cleanup)),
      );
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectAfterDestroy(new Error("WebTorrent seeding cancelled."));
    };
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      rejectAfterDestroy(new Error("WebTorrent did not start seeding before the safety timeout."));
    }, SWARM_START_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    client.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        rejectAfterDestroy(new Error(`WebTorrent failed: ${safeDiagnostic(error)}`));
      }
    });
    client.seed(inspected.file, {
      name: inspected.name,
      announceList: plan.trackers.map((tracker) => [tracker]),
      urlList: [plan.webSeed],
      private: false,
    }, (torrent) => {
      if (settled) return;
      if (torrent.infoHash.toLowerCase() !== plan.infoHash) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        rejectAfterDestroy(new Error("WebTorrent generated a different info hash from the reviewed torrent metadata."));
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(clientStopHandle(client));
    });
  });
}

export async function downloadFromSwarm(
  resolved: ResolvedHybridEvent,
  onProgress: (progress: number, bytesPerSecond: number) => void,
  profile: NetworkProfile = "direct",
  loader: WebTorrentLoader = loadWebTorrent,
  signal?: AbortSignal,
): Promise<{ blob: Blob; session: StopHandle }> {
  if (profile === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  if (signal?.aborted) throw new Error("Swarm download cancelled.");
  if (!resolved.magnetUri || !resolved.infoHash || resolved.trackers.length === 0) {
    throw new Error("The signed event does not contain a usable WebTorrent transport.");
  }
  const { default: WebTorrent } = await loader();
  if (signal?.aborted) throw new Error("Swarm download cancelled.");
  const client = new WebTorrent(privateWebTorrentClientOptions());
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => fail(new Error("Swarm download cancelled."));
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void destroyClient(client).then(
        () => reject(error instanceof Error ? error : new Error(safeDiagnostic(error))),
        (cleanup) => reject(cleanupFailure(error, cleanup)),
      );
    };
    const timer = globalThis.setTimeout(() => fail(new Error("Swarm download timed out.")), SWARM_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    client.on("error", fail);
    client.add(resolved.magnetUri as string, {}, (torrent) => {
      if (settled) return;
      if (torrent.infoHash.toLowerCase() !== resolved.infoHash || torrent.length !== resolved.size) {
        fail(new Error("Torrent metadata does not match the signed Nostr event."));
        return;
      }
      if (torrent.files.length !== 1 || torrent.files[0]?.length !== resolved.size) {
        fail(new Error("Wildbloom accepts one-file torrents only."));
        return;
      }
      torrent.on("download", () => {
        if (!settled) onProgress(torrent.progress, torrent.downloadSpeed);
      });
      void torrent.files[0].blob().then((blob) => {
        if (settled) return;
        return sha256Hex(blob, signal).then((hash) => {
          if (settled) return;
          if (hash !== resolved.sha256) {
            fail(new Error("Swarm bytes failed the signed SHA-256 check."));
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve({ blob, session: clientStopHandle(client) });
        });
      }).catch(fail);
    });
  });
}
