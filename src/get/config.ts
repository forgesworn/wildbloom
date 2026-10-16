/**
 * Build-time configuration for the recipient page (design spec Q8).
 *
 * The pairing service origin is fixed when the page is built, never read from
 * the link, because a link must not be able to point the page at a server of
 * its choosing. Override it for a build with VITE_WILDBLOOM_PAIR_RELAY; tests
 * point it at a loopback service. Nothing contacts it until the user acts.
 */
export const DEFAULT_PAIRING_SERVICE = "https://shelter.forgesworn.dev/pair/v1/";

export const PAIRING_SERVICE: string = import.meta.env.VITE_WILDBLOOM_PAIR_RELAY ?? DEFAULT_PAIRING_SERVICE;

export const PAIRING_NAMESPACE = "wildbloom.drop";
export const PAIRING_PURPOSE = "share";

/** How long to wait after connecting before saying the sender has not answered yet. */
export const SLOW_SENDER_MS = 5000;

/** Plain HTTP is accepted only for a loopback service, which only tests use. */
export function allowsLoopbackHttp(service: string): boolean {
  try {
    const url = new URL(service);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
