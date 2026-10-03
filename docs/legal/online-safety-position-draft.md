# Online Safety Act position

> **DRAFT for legal review, 25 September 2026.** Not legal advice, and it has
> not been reviewed by a lawyer. Drafted from the code on `main` (7eab746) for
> the maintainer to check and adopt. Text in `[square brackets]` is a decision
> or fact still open. Review this again before any change listed in "What
> would change this" below.

## What Wildbloom is

Wildbloom is a static browser application, built and served from this
repository and hosted at wildbloom.forgesworn.dev on Cloudflare Pages
(`docs/DEPLOYMENT.md`). Loading the page runs no network action; publishing,
relay lookup, seeding and downloading are separate, explicit user actions
(README, "Current status").

When someone publishes a file with it, the browser:

- encrypts the file client-side by default before anything leaves the device
  (README, "Local encryption is enabled by default");
- uploads the encrypted envelope to a Blossom server **the user names**, not
  one this project runs or defaults to;
- optionally publishes a signed Nostr event to relays **the user names**;
- optionally seeds the file over WebTorrent to trackers **the user names**.

There is no default relay, no default Blossom server and no default tracker
baked into the app. The user supplies every endpoint the app talks to. The
operator of wildbloom.forgesworn.dev runs no relay, no Blossom server and no
tracker, and receives no copy of any file, key or event: Cloudflare Pages
serves only the static build.

**How the site presents itself (3 October 2026).** The landing page explains
the software and offers no file, upload or download controls.  The client is
a separate view in the same static page, reached only by following an
explicit "Open the client" link (`/#client`; the fragment never reaches the
server).  Before any server field or upload control, the client states that
the site stores nothing, that there is no Wildbloom server, default relay or
default storage, and that publishing needs a Blossom server the visitor runs
or chooses.  The browser acceptance test fails if the landing page exposes a
file control or if that notice does not precede the server field.  Keeping
the site from looking like a hosted upload service matters because how a
service presents itself can shape how users, abuse reporters and a regulator
characterise it.

## The Online Safety Act 2023 question

The Online Safety Act 2023 regulates, among other things, "user-to-user
services": services where content generated or uploaded by one user may be
encountered by another user of the same service (section 3). It also
regulates search services.

**The argument that the hosted web app is out of scope.** On the facts above,
the hosted app at wildbloom.forgesworn.dev does not itself let one user
encounter another user's content. It is software: a page that runs
cryptography and protocol calls in the visitor's own browser, against
third-party servers the visitor chooses. Nobody encounters anyone else's file
*through* wildbloom.forgesworn.dev, because the operator stores nothing and
brokers no connection between users. On that reading, the hosted app is
closer to a code editor or a command-line tool distributed as a web page than
to a user-to-user service, and section 3 does not bite.

**Where this argument is weaker, and could fail.**

1. **It depends on defaults staying empty.** If a future release ships a
   default relay, a default Blossom server, or a default tracker list, the
   operator starts routing user content to and from parties of the operator's
   own choosing, and the "we host nothing, we choose nothing" argument
   weakens. A shipped default is a material change and should trigger a
   fresh look at this document before release.
2. **It depends on the operator not running infrastructure that indexes or
   lists content.** This repository does not run a Blossom server, a relay or
   a crawler. If ForgeSworn ever ran a public relay or Blossom server that
   this app pointed at by default, or ran any index, search or discovery
   feature over files published with Wildbloom, that service (not this
   static app) would need its own assessment, and could look like a
   user-to-user or file-storage service. See
   [Wildbloom Node's operator responsibilities](https://github.com/forgesworn/wildbloom-node/blob/main/docs/OPERATOR-RESPONSIBILITIES.md)
   for that case.
3. **It depends on no feature letting one visitor see another visitor's
   activity through the site itself.** There is none today: no comments, no
   directory, no feed, no chat. Adding any of those would change this
   analysis.
4. **Regulatory characterisation of "provide the means" is not settled by
   this document.** Ofcom's guidance and case law on where "providing
   software that helps people configure their own file exchange" sits,
   relative to "operating the exchange", may develop. `[LEGAL REVIEW: check
   Ofcom's current guidance and any decisions on tooling/software providers
   before relying on this position publicly.]`
5. **Search functionality.** Wildbloom does not search, index or crawl third
   party content; the retrieval flow in the app resolves one event or hash
   the user already has. If that changes, the search-service limb of the Act
   would need separate consideration.

**Conclusion (provisional).** As built today, the hosted web app is best read
as software rather than a user-to-user service, because the operator hosts no
user content, runs no relay, runs no Blossom server, and brokers no encounter
between users. This is a considered position, not a certainty, and it should
be re-checked whenever the facts above change. `[DECISION: the maintainer
should confirm this reading, ideally with a lawyer, before treating it as
settled, and should keep this document under version control as the record of
that reasoning, per Ofcom's general record-keeping expectations for services
that decide the Act does not apply to them.]`

## UK GDPR

The hosted app collects no personal data on the operator's side: there is no
account, no server-side storage of files, keys or events, and no server-side
analytics (see `docs/legal/privacy-notice-draft.md` for the full position,
including what Cloudflare may log as the hosting provider).

## What would change this position

Re-open this document, and treat it as a live question rather than settled,
if any of the following happen:

- a default relay, default Blossom server or default tracker is shipped;
- the client is shown on the landing page again, or the "this site stores
  nothing" notice is removed or moved below the upload controls;
- ForgeSworn runs a public relay, Blossom server, index, search feature or
  crawler that this app points at or that surfaces files published with it;
- any feature is added that lets one visitor encounter another visitor's
  content, activity or metadata through the site itself (comments, a
  directory, a feed, presence, chat);
- server-side analytics, logging of user content, or any account system is
  added;
- Ofcom issues guidance, or a court or tribunal decides a case, that bears
  directly on software-versus-service characterisation for this kind of
  tool.

## Open items

1. `[LEGAL REVIEW]` items above.
2. No named person is designated as accountable for this assessment. `[DECISION:
   name one, even while the conclusion is "out of scope", so there is a
   record of who owns the question.]`
3. This document has not been reviewed by a lawyer.
