# @mailwoman/license-worker

This private package is a Cloudflare Worker at `license.mailwoman.ai` that turns a paid Stripe invoice into a signed
license token. The worker receives Stripe's webhooks, re-reads every entitlement from Stripe by id, mints one token per
invoice, and records it in a D1 ledger. It delivers the token by email and through the claim route that the success
page polls. The routes an installation calls afterwards, refresh and status, read the same ledger.

Spec: `docs/superpowers/specs/2026-09-05-self-service-commercial-license-design.md`. Plan:
`docs/superpowers/plans/2026-09-05-license-worker.md`.

## Two environments

`wrangler.toml` is the flat production configuration. `wrangler.sandbox.toml` is the sandbox configuration and is
passed with `-c`, so a plain `wrangler deploy` always targets production. Each environment has its own D1 database,
rate-limit namespaces, webhook secret, signing key, key id and Price allowlist. Test-mode Stripe keys are never used in
production. The sandbox signing key is never in the shipped register, so in a sandbox the worker trusts its own key.
The self-test derives the public half from the private key and requires its digest to match the configured kid.
Tokens that a sandbox mints verify against that public key and against no key that a release ships. In production,
only an `active` entry of the shipped register passes the self-test.

## Bindings

| Binding                                              | Kind       | Meaning                                                                                                                                                                           |
| ---------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                                  | secret     | a restricted key with read scope on checkout sessions, subscriptions, invoices, invoice payments, disputes                                                                        |
| `STRIPE_WEBHOOK_SECRET`                              | secret     | the webhook destination's signing secret                                                                                                                                          |
| `LICENSE_SIGNING_KEY_PEM`                            | secret     | the worker's Ed25519 private key, PKCS#8 PEM                                                                                                                                      |
| `EMAIL_SENDER`                                       | send_email | Cloudflare's email sending; the license message goes out through it, from `EMAIL_FROM` on the zone, as text and as HTML from the react-email template in `lib/email/template.tsx` |
| `EMAIL_API_KEY`                                      | secret     | a Resend API key, read only when the environment has no `EMAIL_SENDER` binding                                                                                                    |
| `LICENSE_SIGNING_KID`                                | var        | the key id the private key must match, an `active` entry of the shipped register                                                                                                  |
| `ISSUANCE_ENABLED`                                   | var        | the kill switch: `false` refuses to mint and answers claims `pending`; refresh and status keep working                                                                            |
| `STRIPE_LIVE_MODE`                                   | var        | the Stripe mode this environment accepts; an event or invoice from the other mode is refused                                                                                      |
| `SITE_ORIGIN`                                        | var        | the one CORS origin the claim route admits                                                                                                                                        |
| `EMAIL_FROM`                                         | var        | the sender address                                                                                                                                                                |
| `LICENSE_LEDGER`                                     | D1         | the ledger: `licenses`, `license_tokens`, `stripe_events` (`migrations/0001_ledger.sql`)                                                                                          |
| `CLAIM_LIMITER`, `REFRESH_LIMITER`, `STATUS_LIMITER` | rate limit | per client address for claims; per lid and per client address, independently, for refresh and status                                                                              |

If a production var still reads `REPLACE`, `readEnv` refuses every request with 503, so an unfilled deploy never
mints. Secrets are set only through `wrangler secret put`. `.dev.vars.example` lists the four secrets for local
`wrangler dev`.

## First deploy

Two prerequisites must hold before the worker can mint anything. The worker's public key must be an `active` entry of
`LICENSE_SIGNING_KEYS` in `@mailwoman/core`, and a mailwoman release that carries it must be published. No
installation accepts a token signed by a key that its release does not trust, so the self-test refuses to start
before that.

1. Create the D1 database and the three rate-limit namespaces in the Cloudflare account. Write the database id into
   `wrangler.toml` under the environment.
2. Provision the Stripe objects from the catalog in `lib/shop/catalog.ts`. The catalog is the single definition of the
   Product, the two Prices, the Payment Links' shape, the portal's features and the webhook's events:

   ```bash
   yarn mwops shop status --mode live                      # read what the account holds; writes nothing
   yarn mwops shop provision --mode live --apply           # create what is missing; write the ids into lib/shop/ids.json
   ```

   `--mode test` does the same in test mode against `MAILWOMAN_STRIPE_SECRET_KEY`. `--mode live` reads
   `MAILWOMAN_STRIPE_LIVE_SECRET_KEY` and refuses any other prefix. Both modes write `lib/shop/ids.json`, the single
   file that lists the Price ids the worker allowlists, the Payment Links the site renders, and the portal login address
   that the site and the email give a customer. A Payment Link is created only with consent collection. If Stripe
   refuses it, the report reads `blocked`, and the fix is to set the terms-of-service URL under the account's public
   details in the dashboard. The run is idempotent, so a second run reads `exists` everywhere and creates no object. An
   object that differs from the catalog is reported under `drift`. `--apply` updates the fields an update can change (a
   link's promotion codes, a webhook's events). It deactivates and recreates a Payment Link whose agreement or consent
   collection differs. It leaves a Price's amount and a webhook's API version as drift for the operator.

3. Set the four secrets for the environment:

   ```bash
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_SECRET_KEY
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_WEBHOOK_SECRET
   yarn workspace @mailwoman/license-worker wrangler secret put LICENSE_SIGNING_KEY_PEM
   yarn workspace @mailwoman/license-worker wrangler secret put EMAIL_API_KEY
   ```

4. Fill `LICENSE_SIGNING_KID` in `wrangler.toml`. Leave `ISSUANCE_ENABLED = "false"`.
5. Apply the migrations, then deploy. `.github/workflows/deploy.yml` deploys the worker on every push to `main` that
   changes it or one of its dependencies, running `yarn compile` before `wrangler deploy`. A first deploy by hand uses
   the same command:

   ```bash
   yarn workspace @mailwoman/license-worker migrate:production
   yarn workspace @mailwoman/license-worker wrangler deploy
   ```

6. Confirm that `GET /health` reads `{"issuance":false,"liveMode":true,"signing":"ok","ledger":"ok","email":"ok"}`. It
   answers 503 when the ledger does not respond.
7. Create the webhook destination against the deployed origin, and store the secret that Stripe returns once:

   ```bash
   yarn mwops shop provision --mode live --apply --worker-origin https://license.mailwoman.ai
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

   The destination subscribes to the seven event types in `lib/stripe/webhook.ts` and pins the API version the SDK is
   built against. A verified event of another type answers 200 and is logged. Only a failed signature answers 400,
   and Stripe retries that event for three days.

8. Set `ISSUANCE_ENABLED = "true"` in `wrangler.toml` and push. The next build deploys the change.

The same steps with `-c wrangler.sandbox.toml` set up the sandbox on a key pair generated only for it
(`generateLicenseSigningKeyPair` from `@mailwoman/core/license/key`, kid from `licenseKeyID(publicKeyPEM, 9)`). Its
`/health` reads `signing: ok`, and a Payment Link in Stripe test mode exercises the whole path: checkout, webhook,
claim, email, refresh. Verify a sandbox token with `verifyLicenseKey` against the sandbox public key, because no release
trusts it.

The renewal path needs a customer on a Stripe test clock, which a Payment Link cannot create. The rehearsal therefore
builds the Checkout Session itself with the same collection the Link carries (`checkoutCollection` in
`lib/shop/catalog.ts`):

```bash
yarn mwops shop rehearse                                  # prints the session id and the URL; pay it with card 4242 4242 4242 4242
yarn mwops shop rehearse-renewal --session cs_test_… --worker-origin https://mailwoman-license-sandbox.<account>.workers.dev
```

The second command waits for the deployed worker to issue the first token, advances the clock 32 days, waits for Stripe
to pay the renewal and deliver its `invoice.paid`, and reports both tokens' dates with `agrees: true` when the renewed
expiry is the new period end plus the grace. No step is replayed or signed by hand. If a wait times out, check
Stripe's delivery to the worker first.

## The kill switch

To stop issuance, set `ISSUANCE_ENABLED = "false"` and redeploy. The webhook keeps answering 200 and recording events.
`invoice.paid` answers `refused: issuance is disabled` and mints no token. A claim for a license with no token answers
`pending`. Refresh, status, and a claim for an already-minted token keep serving that token. When issuance is turned
back on, the six-hourly reconciliation mints what was refused. That covers every paid invoice of a subscription the
ledger knows, and the first invoice of an unknown subscription if that invoice was created within the last week (the
section below explains why).

## Reconciliation

A Cron Trigger runs `lib/reconcile.ts` every six hours. It mints a token for any paid invoice without one, through the
same path the webhook takes. It re-sends a token whose email is not confirmed as sent (`pending` after a crash, or
`failed`) under the same invoice id. It also corrects a license whose state disagrees with its subscription, including
a dispute that Stripe has since ruled won and a subscription that ended once its token's date has passed. The report in
the worker log contains ids only. A failure on one item is recorded against that item and never stops the sweep for
the rest.

Each pass reads every license in the ledger in full, and mints its subscription's latest paid invoice if no token
holds it, however old the invoice is. A subscription that the ledger has never seen, because its
`checkout.session.completed` was lost and its success page was never visited, can be found only through Stripe's
invoice list, which filters by creation time. Reconciliation therefore recovers it only while its first invoice is less
than a week old. After that, resend the invoice's `invoice.paid` from the Stripe dashboard. A resend through
Cloudflare's binding can deliver twice when the ledger fails to record an accepted send. Resend deduplicates on the
invoice id.

## Refunds and disputes

| Event             | `license_state`                               | Online status        | Offline token                          |
| ----------------- | --------------------------------------------- | -------------------- | -------------------------------------- |
| full refund       | `revoked`                                     | `revoked`            | valid until its `expires`              |
| dispute opened    | `revoked`                                     | `revoked`            | as above                               |
| dispute won       | back to the subscription's state              | as Stripe says       | unchanged                              |
| partial refund    | `review`                                      | `active`             | unchanged; the operator decides        |
| subscription ends | `lapsed` once the current token's date passes | `lapsed` on that day | expires with its 14-day grace, by date |

Public status answers carry no reason, name, or date.

## Running it locally

`yarn dev` runs the worker on the local Workers runtime with a local D1 and the sandbox rate limiters, and it needs
no Cloudflare credential. Secrets and overrides come from `.dev.vars`, which is gitignored and follows the shape of
`.dev.vars.example`. Set the test-mode Stripe key, any string as the webhook secret, the sandbox signing pair's private
half, and `ISSUANCE_ENABLED=true` to mint. Then run:

```bash
yarn workspace @mailwoman/license-worker wrangler d1 migrations apply LICENSE_LEDGER -c wrangler.sandbox.toml --local
yarn workspace @mailwoman/license-worker wrangler dev -c wrangler.sandbox.toml --test-scheduled
curl -s http://localhost:8787/health
curl -s "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"     # one reconciliation pass
```

Stripe cannot deliver a webhook to localhost. A local end-to-end test pays through a test-mode Payment Link in a
browser, reads the session id from the success URL, fetches the resulting events from `/v1/events`, and posts each to
`/v1/webhooks/stripe` signed the way Stripe signs (`t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>" under the local
webhook secret>`). The worker re-reads every object from Stripe by id, so only the delivery is simulated. A renewal
needs a customer on a Stripe test clock, which a Payment Link cannot create. Build a Checkout Session through the API
for that customer with the same price, custom field, consent and metadata that the Link carries. Pay it, advance the
clock past the period end, and replay the renewal's `invoice.paid`. The launch plan's receipt records one such run.

## Tests

`yarn test:license-worker` runs the workspace's suite under `@cloudflare/vitest-pool-workers`. The suite uses
Miniflare's D1 with the migrations applied per file, a Stripe client over a fetch stub that answers by method and path,
and a signing pair minted per run. The root Vitest sweep excludes these files, and CI runs them as a separate step. Run
`yarn compile` first, because the worker imports `@mailwoman/core` through its `default` export condition, which points
to `out/`.

The worker runs without `nodejs_compat`. The `bundle-graph` health check keeps the license subpaths free of Node
builtins, so a violation must be fixed at the import's source and never with a compatibility flag. Secrets never enter
the bundle, because each is a Wrangler secret binding and `upload_source_maps` stays unset. The bundle measures 2.7 MB
before compression and 0.4 MB gzipped.
