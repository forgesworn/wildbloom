/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WILDBLOOM_PAIR_RELAY?: string;
  /** Comma-separated stun:/turn:/turns: URLs; default stun:stun.cloudflare.com:3478. */
  readonly VITE_WILDBLOOM_DIRECT_ICE?: string;
}
