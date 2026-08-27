# Production operations

This runbook covers the public Wildbloom browser and marketing build.  It does
not operate a Blossom server, Nostr relay, WebTorrent tracker or Wildbloom Node.

## Required GitHub configuration

Create a `production` environment restricted to the `main` branch.  Configure:

- environment secret `CLOUDFLARE_API_TOKEN`, limited to Pages deployment for
  the Wildbloom account;
- environment secret `CLOUDFLARE_ACCOUNT_ID`;
- repository variable `WILDBLOOM_PRODUCTION_ORIGIN`, containing one custom
  HTTPS origin with no path, query, fragment or credentials;
- repository variable `WILDBLOOM_PRODUCTION_COMMIT`, containing the full
  lowercase commit currently served at that origin.

The deployment workflow refuses GitHub Pages and `pages.dev` preview hosts as
production.  The Cloudflare token is not available to pull requests and no
workflow accepts a user-selected project name, branch or output directory.
Wrangler is an exact locked development dependency and runs offline from the
clean install rather than being fetched by `npx` during deployment.

## First deployment

1. Create the Cloudflare Pages project named `wildbloom` and attach the custom
   domain.  Finish DNS and certificate validation before calling it production.
2. Record the provider's request-log fields, access controls and retention.
   Wildbloom itself has no analytics, account or application request logging,
   but the DNS, TLS and edge operators can still observe requests and IP
   metadata.
3. Run the `Deploy Cloudflare production` workflow from `main`.  Enter the full
   reviewed commit shown by GitHub, not a branch name or abbreviated hash.
4. The workflow runs the complete release gate, records exact build evidence,
   adds only the reviewed Pages headers and health file, deploys that commit,
   then waits for the custom domain to serve the exact hashes and edge policy.
5. After the workflow passes, set `WILDBLOOM_PRODUCTION_COMMIT` to that exact
   commit and run `Verify production deployment` manually.  Its six-hour
   schedule then rebuilds that recorded commit and checks the live origin.  The
   scheduled job remains disabled until both production variables are present,
   so a preview is never silently adopted as its baseline.
6. Retain the production evidence artefact outside the web root.  Record the
   deployment run, DNS state, certificate state, Pages deployment identifier,
   operator, approval and current rollback target in the private release log.

Do not update the repository homepage, canonical metadata or public release
copy until the custom-domain verification has passed from a logged-out network
location.

## Rollback

Cloudflare Pages retains deployments and permits a previous production
deployment to be rolled back from the dashboard.  Record the intended previous
deployment before release.  If deployment or monitoring fails:

1. stop further production runs;
2. roll back to the last independently verified production deployment;
3. restore `WILDBLOOM_PRODUCTION_COMMIT` to that deployment's exact source;
4. run `Verify production deployment` and retain its result;
5. record the start, detection, rollback and verification times, affected
   origin, operators and known exposure without putting private user material
   into the incident record.

A dashboard success message is not rollback proof.  The old commit's exact
bytes, cache controls, MIME types, security headers, HSTS and `/healthz` must
all pass again.

## Monitoring and logs

The scheduled verifier is deliberately end-to-end.  A `200` health response
alone is insufficient: it also checks every released browser asset against the
recorded source and fails on redirects, changed bytes, MIME drift, cache drift,
security-header drift or insufficient HSTS.

Do not enable third-party analytics, session replay or client error collection
without a separate threat-model, consent and privacy review.  Keep request
targets, query strings, headers and bodies out of operator logs.  Restrict
access to edge metadata, set the shortest operationally defensible retention,
and document the actual value rather than copying an aspiration from this
runbook.

## Still human release gates

Repository automation cannot provide legal name clearance, identify the legal
controller of the deployed domain, choose the lawful basis for processing edge
metadata, set the provider's real retention, or prove human accessibility and
Tor Browser usability.  Record those decisions and evidence before describing
the site as a production service.  The technical privacy model is in
[`PRIVACY.md`](PRIVACY.md); it is not a substitute for the production
operator's legal privacy notice.
