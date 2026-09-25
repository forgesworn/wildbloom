# Privacy notice

> **DRAFT for legal review, 25 September 2026.** Text for the hosted build at
> wildbloom.forgesworn.dev. It has not been reviewed by a lawyer and it is not
> legal advice. HTML comments name the code or configuration behind each
> statement; remove them when the page is built. Text in `[square brackets]`
> is a placeholder or a decision still open.

## 1. Who we are

This notice covers the hosted build of Wildbloom at
wildbloom.forgesworn.dev, run by `[Operator]`. Contact us at
`[contact address]`.

## 2. The short version

- Wildbloom runs in your browser. We do not run a server that receives your
  files, your recovery keys, your Nostr private key, or the Nostr events you
  sign.
- We do not operate accounts, and there is nothing to sign in to.
- We run no analytics and no advertising on this site.
- Loading the page runs no network action. Publishing, looking something up
  on a relay, seeding and downloading are separate actions you choose to
  take, and each one talks only to the third-party server or relay you name.
- Our hosting provider, Cloudflare, may see and log ordinary web-request
  information (such as your IP address) when your browser fetches this page,
  as it would for any site it hosts. That is described in section 4.

<!-- README "Current status" and "Local encryption is enabled by default";
docs/DEPLOYMENT.md ("Wildbloom is a static browser application... For
Cloudflare Pages..."); no server code in this repository receives file bytes,
recovery keys or private keys. -->

## 3. What we do not collect

- **Your files.** Encryption and upload happen in your browser, direct to the
  Blossom server you choose. We never receive the file, the encrypted
  envelope, or the recovery key.
- **Your Nostr private key.** No private key enters Wildbloom. Signing
  happens through an injected NIP-07 extension, or by an external
  copy/sign/paste handoff you control. Wildbloom accepts only the returned
  signed event.
  <!-- README "No private key enters Wildbloom..." -->
- **Account details.** There is no account system, no email address, no
  password.
- **Analytics or advertising identifiers.** We run no analytics script, no
  advertising script and no error-tracking script on this site.

## 4. What our hosting provider may log

Wildbloom.forgesworn.dev is served as a static build from Cloudflare Pages
(`docs/DEPLOYMENT.md`). Cloudflare, as our hosting and content-delivery
provider, may process ordinary web-server information to serve the page and
protect it from abuse, which can include: your IP address, request headers
such as user agent, the page requested, and timing. This is Cloudflare's
processing as our infrastructure provider, not something this project
configures, reads, or receives a copy of.

`[LEGAL REVIEW: confirm the exact retention Cloudflare applies to Pages
request logs for this account, whether any Cloudflare feature beyond plain
static hosting is enabled (for example, Web Analytics or bot management), and
name Cloudflare formally as a processor if UK GDPR requires a data processing
agreement for this arrangement.]`

We do not add our own analytics, cookies, or tracking scripts on top of this.

## 5. Servers you choose to talk to

When you publish or retrieve a file with Wildbloom, your browser talks
directly to:

- **A Blossom server** you name, to upload or fetch the encrypted envelope.
  That server sees your connection (including your IP address) and the file's
  hash, but not the plaintext or the recovery key, because encryption is
  client-side.
- **Nostr relays** you name, if you publish or look up a signed event. Those
  relays see your connection and the signed event you send them.
- **BitTorrent trackers and peers**, only if you choose optional WebTorrent
  seeding. Peers and trackers can see your IP address, as is normal for
  BitTorrent.

None of these are servers this project operates or names by default. You
choose every one of them. See `docs/PRIVACY.md` in this repository for the
full technical privacy and threat-model discussion, including Tor-only mode.

## 6. Cookies and local storage

`[LEGAL REVIEW: confirm the exact set of localStorage/sessionStorage keys the
built app uses, e.g. remembered server addresses or in-progress recovery
state, and whether any of it needs a PECR consent notice. None of it is sent
to us; it stays on your device.]`

## 7. Children

Wildbloom carries no minimum-age gate of its own; it is a general-purpose
publishing tool. We collect no personal data from anyone, of any age, on the
operator's side, for the reasons in section 3.

## 8. Your rights

Because we hold no personal data about you on our side (sections 2 to 3), most
UK GDPR data-subject requests (access, correction, deletion) have nothing to
act on here. If you believe that is wrong, for example because you think
Cloudflare-level logs identify you and you want to ask about them, write to
`[contact address]` and we will help you raise it with Cloudflare or point you
to their own privacy notice.

You can complain to the Information Commissioner's Office (ico.org.uk) at any
time.

## 9. Changes

If we change this notice, we will say so on this page and in this repository's
history.

---

## Open points in this notice

1. The operator entity and contact address (`[Operator]`, `[contact
   address]`).
2. Confirm the exact Cloudflare Pages configuration in use (section 4) and
   whether a data processing agreement or further disclosure is needed.
3. Confirm the exact browser storage keys in use (section 6).
