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
baked into the app. The user supplies every endpoint the app talks to. For
this publishing flow, the operator of wildbloom.forgesworn.dev runs no relay,
no Blossom server and no tracker, and receives no copy of any file, key or
event: Cloudflare Pages serves only the static build. The Share and direct
send pages described below are different.

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

**Node discovery and checkout (10 October 2026, from `main` d7dfadb).** The
client can look up recommended storage nodes and buy storage from one. Both
run in the visitor's browser. Discovery asks only the relays the visitor
named, for server lists signed by public keys the visitor typed in; the app
ships no relay and no trusted key for it. Checkout talks only to the node
the visitor selected, and payment goes to that node's operator. ForgeSworn
runs no part of either. `[LEGAL REVIEW: the note lists adding discovery as
a reason to revisit the software-or-service reading (section 2.2, marked
unchecked); confirm that client-side discovery against user-chosen relays
and keys leaves it unchanged.]`
<!-- index.html:303-332; src/core/discovery.ts:165-186;
src/services-ui.ts:268-286, 333; src/core/services-http.ts:76-83. -->

**Share and direct send (20 October 2026, from `main` 57c0c5b).** Two further
pages, `/get` and `/send`, let the owner of the Wildbloom Drop desktop app
exchange one file with one person they choose. On `/get` that person
downloads a file the owner shared; on `/send` they send a file to the owner's
computer. Each exchange starts from a link and four words the owner passes
on, and both people compare check words before any file moves. Unlike the
client above, these pages have servers built in. They are a private
deployment run for the maintainer's own Drop, not a public service:

- a Foregather pairing relay at shelter.forgesworn.dev, which holds the
  encrypted pairing messages until the session is deleted or expires;
- for `/get`, a Wildbloom Node at the same address, from which the recipient
  downloads the shared file as an encrypted envelope. The node stores only
  what the maintainer's own devices put there and accepts no other uploader;
- for `/send`, the STUN server named in the page build, by default a public
  one run by Cloudflare. ForgeSworn runs no STUN or TURN server for this. The
  configured STUN server learns the public address and port of each end that
  is not hidden, and when it asked. It carries no file data and cannot read
  the file. A build that names a TURN server as well would relay the encrypted
  transfer for an end that hides its address, and that server would see both
  addresses, byte counts and timing.

For Wildbloom, ForgeSworn offers these servers to no one as a service, and
the code holds to that. Only a device holding a grant from the maintainer's
node, which only the maintainer's key can issue, can open a session on the
pairing relay or obtain the node's direct-send ICE configuration, and the node accepts
uploads from the maintainer's key and devices only. The pages take their
pairing relay and ICE servers from the build, never from a link, so another
Drop owner cannot use the relay, and no Wildbloom exchange can use it unless
the maintainer opened the session. Each exchange is
between the maintainer and one person the maintainer invited, and a file
sent with `/send` never rests on a server. `[LEGAL REVIEW: two questions.
First, whether an exchange whose only other party is the provider, an
individual who is not a user under section 227(3), falls outside section 3.
Second, whether serving these pages from the public wildbloom.forgesworn.dev
site breaks "closed means closed", given that a visitor counts as a user
(section 227(2)). See jurisdiction-kit law/gb/online-services.md sections
2.2 and 2.10.]`
<!-- src/get/config.ts:9; src/direct/config.ts (DEFAULT_DIRECT_ICE_URLS);
wildbloom-node docs/PROTOCOL.md "Direct send", "TURN credential issuer" and
"What servers learn". -->

## What ForgeSworn runs

<!-- Law: jurisdiction-kit law/gb/online-services.md, verified 2026-09-28,
sections 1 and 2.2. -->

ForgeSworn publishes software: this static client, and the Wildbloom Node
binaries and source. For Wildbloom it runs no public service: no public
relay, Blossom server or node, and no managed storage tier, and it hosts no
Wildbloom content but the maintainer's own. The only servers it runs for
Wildbloom are the maintainer's private deployment described under "Share and
direct send" above, and a person exchanging a file with the maintainer takes
part only in a session the maintainer opened. Other ForgeSworn deployments,
such as KithMoot's, are outside this document and are assessed separately.
Its intended
income is support, sponsorship, a paid app, or a deploy kit that customers
run in their own cloud account; none of these has ForgeSworn running a node.

ForgeSworn does not control who can use any node, relay or server a visitor
points this client at, including a node someone runs from a ForgeSworn
deploy kit in their own cloud account. That is the basis on which ForgeSworn
treats itself as not the provider of those services (the Act's test of who
the provider is turns on control over who can use the service, section
226). Whoever runs such a node, and anyone with root on its host, can read
what it stores: an upload sent with encryption turned off arrives as
plaintext, with its filename and type.
<!-- index.html:352; src/main.ts:531-533. -->

This document records ForgeSworn's own position. It is not advice to anyone
who runs a node or uses the software.

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

**Conclusion (provisional).** As built today, the hosted publishing client is
best read as software rather than a user-to-user service, because for it the
operator hosts no user content, runs no relay, runs no Blossom server, and
brokers no encounter between users. `/get` and `/send` rest on the same
position: the servers behind them are the maintainer's own and serve no one
else (see "Share and direct send" and its `[LEGAL REVIEW]`). It is a
considered position, not a certainty, and it should be re-checked whenever
the facts above change. `[DECISION: the maintainer
should confirm this reading, ideally with a lawyer, before treating it as
settled, and should keep this document under version control as the record of
that reasoning, per Ofcom's general record-keeping expectations for services
that decide the Act does not apply to them.]`

## UK GDPR

The hosted app collects no personal data on the operator's side: there is no
account, no server-side storage of files, keys or events, and no server-side
analytics (see `docs/legal/privacy-notice-draft.md` for the full position,
including what Cloudflare may log as the hosting provider).

The `/get` and `/send` pages are an exception: the pairing relay that
ForgeSworn runs sees the IP addresses of both people. On `/send`, the
configured STUN server (by default Cloudflare's public one, not run by
ForgeSworn) also learns the public address of each end that is not hidden.
`[LEGAL REVIEW: cover /get and /send in the privacy notice, including what
the pairing relay logs and for how long.]`

## What would change this position

Re-open this document, and treat it as a live question rather than settled,
if any of the following happen:

- a default relay, default Blossom server or default tracker is shipped;
- the client is shown on the landing page again, or the "this site stores
  nothing" notice is removed or moved below the upload controls;
- ForgeSworn runs a public relay, Blossom server, index, search feature or
  crawler that this app points at or that surfaces files published with it;
- a paid app or deploy kit ships a default that points at a server
  ForgeSworn runs, or ForgeSworn runs or manages a node for a customer;
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
