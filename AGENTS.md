# AGENTS.md — Wildbloom

These instructions apply to the whole repository.

## Purpose

Wildbloom is a local-first browser prototype for publishing and retrieving the
same file through three existing protocols: Nostr for signed discovery,
Blossom for content-addressed HTTP delivery, and BitTorrent/WebTorrent for peer
delivery. It is interoperability work, not a new storage network.

## Commands

- `npm run check` — typecheck, tests, production build and repository secret scan
- `npm run ci` — the full check plus a high-severity production dependency audit
- `npm run dev` — local Vite development server

## Security rules

- Never accept, generate, log, persist or transmit an `nsec` or raw private key.
  Browser signing goes through an injected NIP-07 signer after a user action.
- No network action may happen on load. Uploading, relay publication, seeding,
  relay lookup and downloading each require a distinct user action.
- Blossom authorisation events must be short-lived and scoped to the exact
  server hostname and exact blob SHA-256.
- Treat relays, Blossom servers, trackers, peers and signed event content as
  untrusted. Validate sizes, schemes, hashes, signatures and response shapes.
- HTTPS/WSS is mandatory except for explicit localhost development.
- Joining a torrent swarm reveals network metadata. Keep that warning beside
  the action and require acknowledgement.
- Never render remote strings as HTML. Use `textContent` and safe DOM APIs.
- Keep the core framework-free and inject network primitives in tests.
- Use British English in prose. Use ESM and explicit `.js` extensions for
  relative TypeScript imports.

## Protocol scope

- NIP-07 for browser signer access.
- NIP-94 kind `1063` for the primary hybrid file event.
- NIP-35 kind `2003` for torrent indexing.
- BUD-01/02/10/11 for Blossom retrieval, upload, references and authorisation.

These specifications are drafts. Do not silently invent compatibility claims;
document and test any extension tags before adding them.
