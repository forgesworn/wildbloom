export type LinkProblem = "missing" | "expired" | "invalid";

function decodeFragment(fragment: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,1400}$/u.test(fragment)) return undefined;
  try {
    const binary = atob(fragment.replaceAll("-", "+").replaceAll("_", "/"));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
  } catch {
    return undefined;
  }
}

/**
 * Tell an expired link from a broken one. The pairing parser rejects both the
 * same way, so this reads only the public expiry timestamp, never the secret
 * (the link does not hold one) and never the network.
 */
export function classifyLinkFailure(hash: string, nowSeconds: number): LinkProblem {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment.length === 0) return "missing";
  const decoded = decodeFragment(fragment) as { room?: { session?: { expires?: unknown } } } | undefined;
  const expires = decoded?.room?.session?.expires;
  if (typeof expires === "number" && Number.isSafeInteger(expires) && expires <= nowSeconds) return "expired";
  return "invalid";
}
