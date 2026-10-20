/**
 * Build-time configuration for direct send (wildbloom-direct/1).
 *
 * The page accepts TURN and STUN servers only from this list, fixed when the
 * page is built, never from a link or from the inviter: a paired but hostile
 * inviter must not be able to name a server of its own and learn an address the
 * person asked to hide. Override the list for a build with
 * VITE_WILDBLOOM_DIRECT_ICE (comma-separated, exact URLs); tests point it at
 * loopback. Nothing here contacts a server.
 */

export const DIRECT_PROFILE = "wildbloom-direct/1";
/** The pairing purpose of a direct send session. The namespace is the shared `PAIRING_NAMESPACE`. */
export const DIRECT_PURPOSE = "send";
export const DATA_CHANNEL_LABEL = "wildbloom-direct/1";

/** Limits from the protocol's table. */
export const LIMITS = Object.freeze({
  messageBytes: 16_379,
  messagesPerSide: 8,
  restarts: 5,
  sdpBytes: 8_000,
  iceServers: 4,
  urlsPerServer: 4,
  urlBytes: 256,
  credentialBytes: 256,
  maxPlaintextBytes: 250_000_000,
  frameBytes: 65_536,
  minFrameBytes: 16_384,
  unacknowledgedBytes: 8_388_608,
  ackEveryBytes: 1_048_576,
  highWaterBytes: 1_048_576,
  lowWaterBytes: 262_144,
  // A relayed send is paced: TURN servers drop what exceeds their per-allocation rate, and SCTP recovers from the drops too slowly.
  relayBytesPerSecond: 400_000,
  relayBurstBytes: 65_536,
});

/** Description gathering waits at most this long before the description is sent as it stands. */
export const GATHER_MS = 3000;

/** How long the two ends get to find a path the first time before the connection is given up. */
export const CONNECT_GIVE_UP_MS = 90_000;

/**
 * How long a connection that has `failed` gets to come back before the transfer
 * is given up. The inviter restarts ICE when it sees the failure, and a restart
 * takes a few seconds. `disconnected` is not an end: a blip of several seconds
 * recovers by itself, and a connection that is really gone goes on to `failed`.
 */
export const RECONNECT_GIVE_UP_MS = 45_000;

/** The owner's coturn, as KithMoot's install script spells its URLs, plus the explicit transport forms. */
export const DEFAULT_DIRECT_ICE_URLS: readonly string[] = Object.freeze([
  "stun:kithmoot.forgesworn.dev:3478",
  "turn:kithmoot.forgesworn.dev:3478",
  "turn:kithmoot.forgesworn.dev:3478?transport=udp",
  "turn:kithmoot.forgesworn.dev:3478?transport=tcp",
  "turns:kithmoot.forgesworn.dev:5349",
  "turns:kithmoot.forgesworn.dev:5349?transport=tcp",
]);

const ICE_URL = /^(?:stun|turn|turns):[^\s,]+$/u;

/** Reads a build-time list. A malformed list stops the page loading, because a silent fallback would widen the allowlist. */
export function parseIceAllowlist(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return DEFAULT_DIRECT_ICE_URLS;
  const urls = value.split(",").map((entry) => entry.trim());
  for (const url of urls) {
    if (!ICE_URL.test(url) || new TextEncoder().encode(url).length > LIMITS.urlBytes) {
      throw new Error("VITE_WILDBLOOM_DIRECT_ICE must list stun:, turn: or turns: URLs separated by commas.");
    }
  }
  if (!urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"))) {
    throw new Error("VITE_WILDBLOOM_DIRECT_ICE must include at least one turn: or turns: URL.");
  }
  return Object.freeze([...new Set(urls)]);
}

export const DIRECT_ICE_ALLOWLIST: readonly string[] = parseIceAllowlist(import.meta.env.VITE_WILDBLOOM_DIRECT_ICE);
