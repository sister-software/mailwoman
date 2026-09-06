# @mailwoman/license-worker

Private. A Cloudflare Worker at `license.mailwoman.ai` that turns a paid Stripe invoice into a signed license token.
Stripe's webhooks come in, every entitlement is re-read from Stripe by id, one token per invoice is minted and recorded
in a D1 ledger, and the token goes out by email and through the claim route the success page polls. The routes an
installation calls afterwards, refresh and status, read the same ledger.

Spec: `docs/superpowers/specs/2026-09-05-self-service-commercial-license-design.md`. Plan:
`docs/superpowers/plans/2026-09-05-license-worker.md`.

## Two environments

`wrangler.toml` defines `sandbox` and `production` and nothing deployable at the top level. Each has its own D1
database, rate-limit namespaces, webhook secret, signing key, key id, Price allowlist and email credentials. Test-mode
Stripe keys never meet production. The sandbox signing key is never in the shipped register, so in a sandbox the worker
trusts its own key: the self-test derives the public half from the private key and requires it to digest to the
configured kid. Tokens a sandbox mints verify against that public key and against nothing a release ships. In
production only an `active` entry of the shipped register passes the self-test.

## Bindings

| Binding                                              | Kind       | Meaning                                                                                                    |
| ---------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                                  | secret     | a restricted key with read scope on checkout sessions, subscriptions, invoices, invoice payments, disputes |
| `STRIPE_WEBHOOK_SECRET`                              | secret     | the webhook destination's signing secret                                                                   |
| `LICENSE_SIGNING_KEY_PEM`                            | secret     | the worker's Ed25519 private key, PKCS#8 PEM                                                               |
| `EMAIL_API_KEY`                                      | secret     | the transactional email provider's API key                                                                 |
| `LICENSE_SIGNING_KID`                                | var        | the key id the private key must match, an `active` entry of the shipped register                           |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`        | var        | the allowlisted Price IDs; `lib/plans.ts` maps each to a plan code                                         |
| `AGREEMENT_VERSION`                                  | var        | the terms version new Payment Links carry; a session with another version is fulfilled and logged          |
| `ISSUANCE_ENABLED`                                   | var        | the kill switch: `false` refuses to mint and answers claims `pending`; refresh and status keep working     |
| `STRIPE_LIVE_MODE`                                   | var        | the Stripe mode this environment accepts; an event or invoice from the other mode is refused               |
| `SITE_ORIGIN`                                        | var        | the one CORS origin the claim route admits                                                                 |
| `EMAIL_FROM`                                         | var        | the sender address                                                                                         |
| `LICENSE_LEDGER`                                     | D1         | the ledger: `licenses`, `license_tokens`, `stripe_events` (`migrations/0001_ledger.sql`)                   |
| `CLAIM_LIMITER`, `REFRESH_LIMITER`, `STATUS_LIMITER` | rate limit | per client address for claims; per lid AND per client address, independently, for refresh and status       |

A production var still reading `REPLACE` makes `readEnv` refuse every request with 503, so an unfilled deploy never
mints. Secrets arrive only through `wrangler secret put`; `.dev.vars.example` names the four for local `wrangler dev`.

## First deploy

Prerequisites before the worker can mint anything: the worker's public key is an `active` entry of
`LICENSE_SIGNING_KEYS` in `@mailwoman/core`, and a mailwoman release carrying it is published. A token signed by a key
the installed release does not trust is a token no installation accepts, which is why the self-test refuses first.

1. Create the D1 database and the three rate-limit namespaces in the Cloudflare account. Write the database id into
   `wrangler.toml` under the environment.
2. Provision the Stripe objects from the catalog in `lib/shop/catalog.ts`, which is the one definition of the Product,
   the two Prices, the Payment Links' shape, the portal's features and the webhook's events:

   ```bash
   yarn mwops shop status --mode live                      # read what the account holds; writes nothing
   yarn mwops shop provision --mode live --apply           # create what is missing; write the Price ids into wrangler.toml
   ```

   `--mode test` does the same in test mode against `MAILWOMAN_STRIPE_SECRET_KEY` and writes the sandbox
   environment; `--mode live` reads `MAILWOMAN_STRIPE_LIVE_SECRET_KEY`, refuses any other prefix, and also writes the
   Payment Links into `docs/src/license/shop.ts`. A Payment Link is created only with consent collection; if Stripe
   refuses it, the report reads `blocked` and the remedy is the terms-of-service URL under the account's public details
   in the dashboard. The run is idempotent: a second run reads `exists` everywhere and creates nothing.

3. Set the four secrets for the environment:

   ```bash
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_SECRET_KEY --env production
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_WEBHOOK_SECRET --env production
   yarn workspace @mailwoman/license-worker wrangler secret put LICENSE_SIGNING_KEY_PEM --env production
   yarn workspace @mailwoman/license-worker wrangler secret put EMAIL_API_KEY --env production
   ```

4. Fill `LICENSE_SIGNING_KID` in `wrangler.toml`. Leave `ISSUANCE_ENABLED = "false"`.
5. Run the `license-worker` workflow with `migrate` checked. It tests, bundles, refuses a `node:` import, applies the
   migrations, and deploys.
6. Confirm `GET /health` reads `{"issuance":false,"liveMode":true,"signing":"ok","ledger":"ok"}`; it answers 503
   when the ledger does not respond.
7. Create the webhook destination against the deployed origin, and store the secret it answers once:

   ```bash
   yarn mwops shop provision --mode live --apply --worker-origin https://license.mailwoman.ai
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_WEBHOOK_SECRET --env production
   ```

   The destination subscribes to the seven event types in `lib/stripe/webhook.ts` and pins the API version the SDK is
   built against. A verified event of another type answers 200 and is logged; only a failed signature answers 400,
   which Stripe retries for three days.

8. Set `ISSUANCE_ENABLED = "true"` and run the workflow again without `migrate`.

The same steps with `--env sandbox` stand up the sandbox on a key pair generated for it alone
(`generateLicenseSigningKeyPair` from `@mailwoman/core/license/key`, kid from `licenseKeyID(publicKeyPEM, 9)`). Its
`/health` reads `signing: ok`, and a Payment Link in Stripe test mode runs the whole path: checkout, webhook, claim,
email, refresh. Verify a sandbox token with `verifyLicenseKey` against the sandbox public key; no release trusts it.

## The kill switch

`ISSUANCE_ENABLED = "false"` and a redeploy. The webhook keeps answering 200 and recording events, `invoice.paid`
answers `refused: issuance is disabled` and mints nothing, claims answer `pending`, and refresh and status keep serving
what was already minted. Turning it back on lets the six-hourly reconciliation mint every paid invoice it refused.

## Reconciliation

A Cron Trigger every six hours runs `lib/reconcile.ts` over the last week of paid invoices. It mints a paid invoice with
no token through the same path the webhook takes, sends a token whose email is not confirmed sent (`pending` after a
crash, or `failed`) under the same invoice id, which the provider deduplicates, and corrects a license whose state
disagrees with its subscription, including a dispute Stripe has since ruled won and a subscription that ended once
its token's date has passed. The
report in the worker log names ids only. A license whose Stripe records cannot be read is reported and never stops the
sweep for the rest.

## Refunds and disputes

| Event             | `license_state`                               | Online status        | Offline token                          |
| ----------------- | --------------------------------------------- | -------------------- | -------------------------------------- |
| full refund       | `revoked`                                     | `revoked`            | valid until its `expires`              |
| dispute opened    | `revoked`                                     | `revoked`            | as above                               |
| dispute won       | back to the subscription's state              | as Stripe says       | unchanged                              |
| partial refund    | `review`                                      | `active`             | unchanged; the operator decides        |
| subscription ends | `lapsed` once the current token's date passes | `lapsed` on that day | expires with its 14-day grace, by date |

Public status answers carry no reason, no name and no date.

## Running it locally

`wrangler dev --env sandbox` runs the worker on the local Workers runtime with a local D1 and the sandbox rate limiters;
no Cloudflare credential is needed. Secrets and overrides come from `.dev.vars` (gitignored; `.dev.vars.example` is
the shape): the test-mode Stripe key, any string as the webhook secret, the sandbox signing pair's private half, and
`ISSUANCE_ENABLED=true` to mint. Then:

```bash
yarn workspace @mailwoman/license-worker wrangler d1 migrations apply LICENSE_LEDGER --env sandbox --local
yarn workspace @mailwoman/license-worker wrangler dev --env sandbox --test-scheduled
curl -s http://localhost:8787/health
curl -s "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"     # one reconciliation pass
```

Stripe cannot deliver a webhook to localhost. A local end to end pays through a test-mode Payment Link in a browser,
reads the session id off the success URL, fetches the resulting events from `/v1/events`, and posts each to
`/v1/webhooks/stripe` signed the way Stripe signs (`t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>" under the local
webhook secret>`). The worker re-reads every object from Stripe by id, so only the delivery is simulated. A renewal needs a
customer on a Stripe test clock, which a Payment Link cannot create: build a Checkout Session through the API for that
customer with the same price, custom field, consent and metadata the Link carries, pay it, advance the clock past the
period end, and replay the renewal's `invoice.paid`. The launch plan's receipt records one such run.

## Tests

`yarn test:license-worker` runs the workspace's suite under `@cloudflare/vitest-pool-workers`: Miniflare's D1 with the
migrations applied per file, a Stripe client over a fetch stub that answers by method and path, and a signing pair minted
per run. The root Vitest sweep excludes these files; CI runs them as their own step. `yarn compile` first: the worker
imports `@mailwoman/core` through its `default` export condition, which names `out/`.

The bundle is checked at deploy time: `wrangler deploy --dry-run` writes it, and a `"node:` import, a private-key
marker, or a Stripe key prefix in it fails the workflow, as does `upload_source_maps = true` in `wrangler.toml`. The worker runs without `nodejs_compat`, so the remedy for a hit is at the import's source, never a
compatibility flag. Measured at 2.1 MB before compression.
