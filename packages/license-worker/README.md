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
Stripe keys never meet production, and the sandbox signing key is never in the shipped register, so a sandbox deploy
reads `signing: mismatch` on `/health` by design and refuses to mint. The route tests inject the signing status for that
reason.

## Bindings

| Binding                                              | Kind       | Meaning                                                                                                    |
| ---------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                                  | secret     | a restricted key with read scope on checkout sessions, subscriptions, invoices, invoice payments, disputes |
| `STRIPE_WEBHOOK_SECRET`                              | secret     | the webhook destination's signing secret                                                                   |
| `LICENSE_SIGNING_KEY_PEM`                            | secret     | the worker's Ed25519 private key, PKCS#8 PEM                                                               |
| `EMAIL_API_KEY`                                      | secret     | the transactional email provider's API key                                                                 |
| `LICENSE_SIGNING_KID`                                | var        | the key id the private key must match, an `active` entry of the shipped register                           |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`        | var        | the allowlisted Price IDs; `lib/plans.ts` maps each to a plan code                                         |
| `AGREEMENT_VERSION`                                  | var        | the terms version stamped into each license row and token                                                  |
| `ISSUANCE_ENABLED`                                   | var        | the kill switch: `false` refuses to mint and answers claims `pending`; refresh and status keep working     |
| `STRIPE_LIVE_MODE`                                   | var        | the Stripe mode this environment accepts; an event or invoice from the other mode is refused               |
| `SITE_ORIGIN`                                        | var        | the one CORS origin the claim route admits                                                                 |
| `EMAIL_FROM`                                         | var        | the sender address                                                                                         |
| `LICENSE_LEDGER`                                     | D1         | the ledger: `licenses`, `license_tokens`, `stripe_events` (`migrations/0001_ledger.sql`)                   |
| `CLAIM_LIMITER`, `REFRESH_LIMITER`, `STATUS_LIMITER` | rate limit | per client address for claims; per lid for refresh and status                                              |

A production var still reading `REPLACE` makes `readEnv` refuse every request with 503, so an unfilled deploy never
mints. Secrets arrive only through `wrangler secret put`; `.dev.vars.example` names the four for local `wrangler dev`.

## First deploy

Prerequisites before the worker can mint anything: the worker's public key is an `active` entry of
`LICENSE_SIGNING_KEYS` in `@mailwoman/core`, and a mailwoman release carrying it is published. A token signed by a key
the installed release does not trust is a token no installation accepts, which is why the self-test refuses first.

1. Create the D1 database and the three rate-limit namespaces in the Cloudflare account. Write the database id into
   `wrangler.toml` under the environment.
2. Set the four secrets for the environment:

   ```bash
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_SECRET_KEY --env production
   yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_WEBHOOK_SECRET --env production
   yarn workspace @mailwoman/license-worker wrangler secret put LICENSE_SIGNING_KEY_PEM --env production
   yarn workspace @mailwoman/license-worker wrangler secret put EMAIL_API_KEY --env production
   ```

3. Fill `LICENSE_SIGNING_KID`, `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` in `wrangler.toml`. Leave
   `ISSUANCE_ENABLED = "false"`.
4. Run the `license-worker` workflow with `migrate` checked. It tests, bundles, refuses a `node:` import, applies the
   migrations, and deploys.
5. Confirm `GET /health` reads `{"issuance":false,"liveMode":true,"signing":"ok"}`.
6. Point the Stripe webhook destination at `POST /v1/webhooks/stripe` with the seven event types in
   `lib/stripe/webhook.ts`, and copy its signing secret into step 2 if it changed.
7. Set `ISSUANCE_ENABLED = "true"` and run the workflow again without `migrate`.

The same steps with `--env sandbox` stand up the sandbox, whose `/health` reads `signing: mismatch` until a sandbox
key is added to the register, which it never is; drive it with the route tests and `wrangler dev` instead.

## The kill switch

`ISSUANCE_ENABLED = "false"` and a redeploy. The webhook keeps answering 200 and recording events, `invoice.paid`
answers `refused: issuance is disabled` and mints nothing, claims answer `pending`, and refresh and status keep serving
what was already minted. Turning it back on lets the six-hourly reconciliation mint every paid invoice it refused.

## Reconciliation

A Cron Trigger every six hours runs `lib/reconcile.ts` over the last week of paid invoices. It mints a paid invoice with
no token through the same path the webhook takes, re-sends a token whose email failed under the same invoice id, and
corrects a license whose state disagrees with its subscription, including a dispute Stripe has since ruled won. The
report in the worker log names ids only. A license whose Stripe records cannot be read is reported and never stops the
sweep for the rest.

## Refunds and disputes

| Event             | `license_state`                  | Online status  | Offline token                          |
| ----------------- | -------------------------------- | -------------- | -------------------------------------- |
| full refund       | `revoked`                        | `revoked`      | valid until its `expires`              |
| dispute opened    | `revoked`                        | `revoked`      | as above                               |
| dispute won       | back to the subscription's state | as Stripe says | unchanged                              |
| partial refund    | `review`                         | `active`       | unchanged; the operator decides        |
| subscription ends | `lapsed`                         | `lapsed`       | expires with its 14-day grace, by date |

Public status answers carry no reason, no name and no date.

## Tests

`yarn test:license-worker` runs the workspace's suite under `@cloudflare/vitest-pool-workers`: Miniflare's D1 with the
migrations applied per file, a Stripe client over a fetch stub that answers by method and path, and a signing pair minted
per run. The root Vitest sweep excludes these files; CI runs them as their own step. `yarn compile` first: the worker
imports `@mailwoman/core` through its `default` export condition, which names `out/`.

The bundle is checked at deploy time: `wrangler deploy --dry-run` writes it, and a `"node:` import in it fails the
workflow. The worker runs without `nodejs_compat`, so the remedy for a hit is at the import's source, never a
compatibility flag. Measured at 2.1 MB before compression.
