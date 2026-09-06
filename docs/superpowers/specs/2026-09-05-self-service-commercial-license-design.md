# Self-service commercial licensing: a Stripe subscription that mints a signed license key

**Status:** design approved 2026-09-05 (subscription model, Payment Link, portal, no login, D1-only worker, and the
per-period token chosen by the operator).
**Builds on:** PR #2117 (the signed key), PR #2153 (the engine stamp, the `/license` page, the notice), issue #2121
(the original proposal, whose security requirements this design keeps).
**Supersedes:** the scratchpad proposal's one-time payment, `POST /v1/checkout-sessions` endpoint, and Cloudflare Queue.
**Revised 2026-09-05:** no separate key package and no compatibility re-exports; the key format stays in core on
WebCrypto and the worker imports it by subpath under export conditions.

## The problem

A commercial license exists (`COMMERCIAL-LICENSE.md`, `LicenseRef-Commercial`), a signed key format exists
(`mwl1.<payload>.<signature>`, Ed25519, verified offline against the public keys each release ships), and the
operator can mint one by hand with `mailwoman license issue`. There is no way for a customer to buy one without
writing an email and waiting for a person. The pricing page (`docs/articles/pricing.mdx`, routed at `/docs/pricing`)
already publishes two prices, $250 a month or $2,400 a year per legal entity, so the shop must sell both.

Everything a customer needs to manage billing, Stripe already hosts: cards, invoices, renewal, cancellation, tax
details, and an email-link login to reach them. What Stripe cannot show is the license key, its expiry, or a way to
fetch the current one. This design builds the part Stripe cannot and leans on Stripe for the rest.

## Decisions taken

**A yearly or monthly subscription, not a one-time payment.** Stripe's Customer Portal does renewal payment methods
and cancellation only for a subscription, and both published prices are recurring.

**The token follows the billing period.** Every `invoice.paid` mints a new token whose `expires` is the period end
plus a 14-day grace window. An offline credential is what a customer keeps after cancelling, so it must never outlive
what was paid for by more than the grace. A monthly customer therefore holds a new token each month, delivered by email
and fetchable with `mailwoman license refresh`.

**Stripe Payment Links, not a session-creation endpoint.** A Payment Link supports the licensee-name custom field,
required terms acceptance, tax ID collection, a success URL with `{CHECKOUT_SESSION_ID}`, and `client_reference_id`.
That removes the endpoint, its rate limit, its CORS rule, and the pre-allocated order; Stripe's own IDs carry
idempotency instead.

**Stripe's no-code Customer Portal for billing; no Mailwoman login.** A "Manage billing" link on the `/license` page
opens Stripe's portal login. Recovery of the key is `mailwoman license refresh` with the per-license secret issued at
purchase, so a "My Licenses" web page is not needed until a customer holds several licenses.

**No Cloudflare Queue.** Stripe retries an undelivered webhook with backoff for up to three days; a handler that
returns 5xx on any failure and writes D1 under unique constraints gets at-least-once delivery and idempotency from
that alone. A queue arrives when a measurement calls for one.

**The key format stays in `@mailwoman/core`, and the worker imports it by subpath.** Ed25519 moves from `node:crypto`
onto WebCrypto, which Node, `workerd`, and browsers all implement, so one implementation signs and verifies everywhere.
The worker imports `@mailwoman/core/license/key` and `@mailwoman/core/license/register`, never the `license` barrel and
never a module that reaches `node:fs`; a bundle test holds that line. Where a core module's implementation must differ
per platform, its `package.json` export carries `workerd` and `browser` conditions beside `node`, the way the browser
tier of `@mailwoman/neural` already does. No second package.

**No compatibility re-exports.** A name that moves is imported from its new home by every caller in the same change.
A function that becomes async is awaited by every caller in the same change.

**The worker holds its own signing key.** A second key id, never the operator's local `v9-ecec29be`. A leaked worker
key then retires without touching hand-issued licenses.

**Offline verification stays the anchor.** Online status can tighten a verdict, never manufacture trust. A network
failure reads `unreachable`, a site that answers without a register reads `unpublished`, and the doctor says which.

## Prerequisites the code cannot supply

These are operator work; the first sale waits on them, the implementation does not:

1. **Self-executing terms.** `COMMERCIAL-LICENSE.md` says it is a non-self-executing template and that no rights are
   granted until terms are agreed in writing. A paid Checkout cannot grant under that text. A versioned clickwrap
   agreement, published at a stable URL under `/license/terms/<version>` and accepted through Stripe's
   `consent_collection.terms_of_service`, replaces it for self-service; the agreement version is recorded on every
   license. The template stays for negotiated agreements. Legal and tax review for the markets Checkout is enabled in
   is part of this item.
2. **Merchant identity.** The Stripe account's legal name matches the licensor named in the terms.
3. **A release that trusts the worker's key.** The worker's public key enters `TRUSTED_LICENSE_SIGNING_KEYS` and the
   well-known register, and a mailwoman release publishes, before the first token is sold. A token signed by a key
   the installed release does not trust reads `unknown_key`.
4. **Stripe objects.** Two Products or one Product with two Prices (monthly, yearly), two Payment Links, the Customer
   Portal enabled, a webhook destination for the events listed below, and the test-mode twins of all of it.
5. **A transactional email account.** One provider with an HTTP API and an idempotency key per message.

## Architecture

```mermaid
flowchart LR
  Page[mailwoman.ai /license] -->|Payment Link| Checkout[Stripe Checkout]
  Checkout -->|success URL| Issued[mailwoman.ai /license/issued]
  Stripe[Stripe] -->|signed webhooks| Worker[license.mailwoman.ai]
  Worker --> D1[(D1)]
  Worker -->|encodeLicenseKey| Key[@mailwoman/core/license/key]
  Worker -->|one message per token| Email[email provider]
  Issued -->|poll claim| Worker
  CLI[mailwoman license refresh] -->|lid + secret| Worker
  Doctor[mailwoman doctor --online] --> Register[/.well-known/…/license-keys.json on Pages/]
  Doctor -->|lid| Worker
```

Three places, each with one job:

| Place                                                                  | Job                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `docs/` (GitHub Pages, `mailwoman.ai`)                                 | the `/license` page with both Payment Links and the portal link; the `/license/issued` success page; the static well-known register |
| `packages/license-worker/` (Cloudflare Worker, `license.mailwoman.ai`) | webhook verification, fulfilment, D1 ledger, signing, claim, refresh, status, email                                                 |
| `@mailwoman/core/license/key`, `/register` (subpath exports)           | the key format: payload schema, `encodeLicenseKey`, `verifyLicenseKey`, `licenseKeyID`, on WebCrypto; the typed key register        |

## The key format on WebCrypto, worker-safe by subpath

`packages/core/lib/license/key.ts` keeps the payload schema, `encodeLicenseKey`, `verifyLicenseKey`, `licenseKeyID` and
`generateLicenseSigningKeyPair`. The four Ed25519 helpers leave `#hash`, which reaches `node:fs` for `sha256File`, for a
new `packages/core/lib/crypto/ed25519.ts` on `globalThis.crypto.subtle`: import and export of SPKI and PKCS8 DER, PEM
as a base64 transform of those bytes, sign, verify. Node 24 implements Ed25519 in `SubtleCrypto`, as do `workerd` and
every current browser, so there is one implementation and no condition is needed for it. `sha256Hex`, which
`licenseKeyID` uses on the DER bytes, moves beside it onto `crypto.subtle.digest`; `#hash` keeps the file digests.

Signing and verifying become `async`, because WebCrypto is. Every caller changes in the same PR: `verifyConfiguredLicenseKey`
and `buildEngineStamp`'s input, `resolveEngineStamp`, `runtimeLicenseCheck`'s observation, the `license
keygen|issue|verify` command, and the tests. `resolveEngineStamp` already answers a promise and the doctor's runner is
already async, so the change is in signatures, not in control flow.

**Export conditions.** The worker bundles with Wrangler's esbuild, which resolves `exports` under the `workerd`,
`worker`, and `browser` conditions before `default`. Every core subpath the worker imports must resolve to a module
graph free of `node:*` on those conditions. For `./license/key` and `./license/register` the graph is already free of
them once Ed25519 is on WebCrypto (`#objects` reaches `spliterator` and a type from `path-ts`, both platform-neutral).
A core module that needs a platform-specific implementation gets two files and a conditional entry:

```json
"./license/key": {
	"types": "./out/license/key.d.ts",
	"node": "./lib/license/key.ts",
	"default": "./out/license/key.js"
}
```

is the shape for a neutral module; a split module adds `"workerd"` and `"browser"` entries pointing at its web file,
as `@mailwoman/neural/onnx-runner` does with its `browser` condition today. The bundle test below is what says whether a
subpath is neutral or needs the split; the design does not guess.

**The bundle test.** `packages/core/test/integration/worker-bundle.test.ts` runs esbuild with
`--platform=neutral --conditions=workerd,worker,browser` over an entry that imports `@mailwoman/core/license/key` and
`@mailwoman/core/license/register`, and fails on any `node:` specifier the bundle would need. It is the same shape as
`browser-slo.test.ts` in `@mailwoman/neural`, and it is the check that refuses a `node:` import reaching the worker as core grows.

**Payload v1 gains two optional fields, required for self-service tokens:**

```ts
{
  // …existing fields…
  lid?: string        // opaque per-license serial, `lic_<22 base64url chars>`, stable for the subscription's life
  agreement?: string  // the accepted terms version, e.g. `commercial-2026-10`
}
```

An installed release that predates the fields verifies such a token: the schema is a plain object that strips
unknown keys, and the signature covers the raw payload bytes. The token carries no email, no Stripe IDs, no amount,
no currency. `licensee` stays the one human identity in it.

**Key states** become data rather than prose. One typed register, `packages/core/lib/license/register.ts`, exported as
`@mailwoman/core/license/register`, holds every key with its `status`: `active` (may sign and verify), `retired` (may no
longer sign; existing tokens still verify offline), `revoked` (compromised; online status rejects at once and the next
release removes offline trust). `TRUSTED_LICENSE_SIGNING_KEYS` and the well-known JSON both derive from it at build
time, so the two cannot disagree; `trusted-keys.ts` is deleted, and its importers read the register. Today's `retired`
acts as revocation; after this change it does not.

## The worker

A private workspace `packages/license-worker/`, beside `packages/tile-worker/` and sharing nothing with it. It joins
the seven registers a new workspace joins (`workspaces`, both `tsconfig.json` references, the release-list absence
recorded in `SANCTIONED_RELEASE_ABSENCES` with the reason "private infrastructure", the smoke pack set, and, being
private, neither `bless-package` nor the release list). Unlike `tile-worker`, it gets a deploy workflow:
`.github/workflows/license-worker.yml` runs `wrangler deploy` on a manual dispatch with the environment as input.

Two Wrangler environments, `sandbox` and `production`, each with its own D1 database, webhook secret, signing key, key
id, Price allowlist, and email credentials. Test-mode Stripe keys never meet the production environment, and the
sandbox signing key never enters shipped trust.

### Bindings

| Binding                                       | Kind   | Meaning                                                                                                      |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `STRIPE_SECRET_KEY`                           | secret | the account's restricted key, read scope on checkout sessions, subscriptions, invoices, customers            |
| `STRIPE_WEBHOOK_SECRET`                       | secret | the webhook destination's signing secret                                                                     |
| `LICENSE_SIGNING_KEY_PEM`                     | secret | the worker's private key                                                                                     |
| `EMAIL_API_KEY`                               | secret | the transactional email provider                                                                             |
| `LICENSE_SIGNING_KID`                         | var    | the key id the private key must match                                                                        |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` | var    | the allowlisted Price IDs, each mapped to a plan code                                                        |
| `AGREEMENT_VERSION`                           | var    | the terms version Checkout must have collected consent for                                                   |
| `ISSUANCE_ENABLED`                            | var    | the kill switch: `false` refuses to mint and answers claims `pending`; verification and refresh keep working |
| `SITE_ORIGIN`                                 | var    | `https://mailwoman.ai`, the one CORS origin the claim route admits                                           |
| `DB`                                          | D1     | the ledger                                                                                                   |

At startup the worker signs a fixed probe with `LICENSE_SIGNING_KEY_PEM`, derives the key id from the matching public
key, and refuses every request with a 503 if it differs from `LICENSE_SIGNING_KID` or is absent from the shipped
register's `active` entries. The worker's own bundle is what the bundle test above proves `node:`-free.

### Plan catalog

Code, not Stripe metadata and not client input:

```ts
interface CommercialPlan {
	code: "commercial-monthly-v1" | "commercial-yearly-v1"
	stripePriceID: string // from the var above
	scope: "all"
	terms: "LicenseRef-Commercial"
	agreement: string // from AGREEMENT_VERSION
	graceDays: 14
}
```

### Routes

**`POST /v1/webhooks/stripe`.** Reads the body once as text, verifies `Stripe-Signature` with the official
constructor and a 300-second tolerance, and accepts only these event types:

- `checkout.session.completed` — records the licensee's legal name (the required custom field), the consent record, the
  customer, and the subscription against a new `licenses` row keyed by subscription id, minting `lid` and the refresh
  secret. Mints no token: the first `invoice.paid` does.
- `invoice.paid` — the mint. Retrieves the invoice and its subscription from Stripe (never trusting the event body),
  confirms `paid`, that the one line item's Price is allowlisted, that live/test mode matches the environment, and that
  the subscription's `licenses` row exists. When the row does not exist yet, because this event outran
  `checkout.session.completed`, it lists the Checkout Session for the subscription and creates the row from it, so
  ordering cannot lose a licensee name. Computes `issued` (the invoice's paid date, UTC) and `expires` (the period end
  plus `graceDays`, as an inclusive UTC calendar date), persists both, signs, stores the token, and enqueues nothing:
  the email send happens in the same request, keyed by invoice id, and a failed send leaves the token issued with
  `email_state = failed` for the reconciliation pass to retry.
- `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` — update `payment_state`
  and `subscription_state`; no token is minted or altered. A deleted subscription marks the license `lapsed` once the
  grace window passes.
- `charge.refunded` (full) and `charge.dispute.created` — mark the license `revoked` online. A partial refund marks
  `review` and mints nothing; the operator decides.
- `charge.dispute.closed` — reconciles to Stripe's current payment state.

Every event id is written to `stripe_events` first, in the same D1 batch as its effects; a duplicate id is a no-op 200. Any failure after signature verification answers 500 so Stripe retries. Bad signatures answer 400 and are never
retried. Nothing logs a body, a customer field, a token, or a secret.

**`GET /v1/checkout-sessions/:sessionID/license`.** The success page's claim. Answers `{ status }` with
`pending`, `issued`, `failed`, or `revoked`, and for `issued` the token, the licensee, `issued`, `expires`, `lid`, and
the refresh secret. `Cache-Control: no-store`; CORS exactly `SITE_ORIGIN`; never a redirect. Possession of the Checkout
Session id is the capability, as it is on Stripe's own success pages; the page sends no referrer to third parties.

**`POST /v1/licenses/refresh`.** Body `{ lid, secret }`. Answers the current token for an `active` license whose
secret hashes to the stored value, `{ status: "revoked" | "lapsed" }` otherwise, and the same `404` for an unknown lid
and a wrong secret. Rate-limited per lid and per address. This is the customer's recovery path and their monthly
fetch.

**`POST /v1/license-status`.** Body `{ lid }`. Answers `active`, `lapsed`, `revoked`, or `unknown`, nothing else.
`mailwoman license verify --online` and the doctor call it for tokens that carry `lid`, beside the key-id check
against the well-known register.

**`GET /health`.** Signing self-test result, D1 reachability, `ISSUANCE_ENABLED`. No customer data.

### D1 schema

`licenses`: `lid` (PK), `subscription_id` (unique), `customer_id`, `plan_code`, `agreement_version`, `licensee`,
`email`, `refresh_secret_sha256`, `subscription_state`, `payment_state`, `license_state`
(`active | lapsed | revoked | review`), `created_at`, `updated_at`.

`license_tokens`: `invoice_id` (PK), `lid` (FK), `issued`, `expires`, `payload_json`, `token`, `email_state`
(`sent | failed`), `email_message_id`, `created_at`. One row per paid invoice; the current token is the row with the
latest `expires`.

`stripe_events`: `event_id` (PK), `type`, `object_id`, `received_at`, `outcome`.

Tokens at rest are what the customer already holds, so they are stored as written; the D1 database is customer data
and gets the same retention, export, and deletion handling as the Stripe account.

### Reconciliation

A Cron Trigger every six hours lists subscriptions from Stripe that changed in the window and compares them with
`licenses`: a paid invoice with no `license_tokens` row is minted; a `sent`-less token is re-sent under the same
invoice id; a state that disagrees with Stripe is corrected. It writes a one-line report per drift to the worker log
with ids only.

## The docs site

**`/license`** (`docs/src/pages/license.mdx`, already live) gains a "Buy" section with the two Payment Links, the
"Manage billing" portal link, and a paragraph on the refresh command. The contact address stays for enterprise and
negotiated terms.

**`/license/issued`** (`docs/src/pages/license/issued.tsx`): reads `session_id` from the query, polls the claim route
until `issued`, then shows the licensee, scope, `issued`, `expires`, the token with a copy button, the refresh secret
with its own copy button and a one-line warning that it is shown once, the `.env` fragment, the two commands to run, and
the portal link. A `pending` beyond two minutes shows the support address and says the email will arrive on its own.

**`/license/terms/<version>`**: the clickwrap agreement, one page per version, never edited after publication.

## The CLI

`mailwoman license refresh` reads `lid` and the secret from `$MAILWOMAN_CONFIG_ROOT/license/refresh.json` (written
`0600` by `mailwoman license adopt <token> --secret <s>` after purchase, or passed as flags), calls the refresh route,
verifies the answer offline against the shipped register, and writes it to `$MAILWOMAN_CONFIG_ROOT/license/key`.
`verifyConfiguredLicenseKey` reads `MAILWOMAN_LICENSE_KEY` first and that file second, so a refreshed key applies
without an environment change. `license verify --online` and the doctor add the `lid` status beside the key-id
publication, and report `active`, `lapsed`, `revoked`, `unknown`, or `unreachable` as distinct words.

## Key rollout and rotation

1. Generate the worker's key pair offline.
2. Add the public half to the register as `active`; open the release PR; publish the mailwoman release.
3. Confirm the published tarball and the deployed well-known JSON both carry it.
4. Install the private half as the production secret.
5. Deploy the worker with `ISSUANCE_ENABLED=false`; confirm `/health` reports the self-test passed.
6. Enable the Payment Links on the page.

Rotation: add the new key as `active` and release; switch the worker to it; mark the old key `retired` in the register
and release; keep it `retired` until every token it signed has expired. Compromise: mark `revoked` and release; online
status refuses its tokens at once.

## Refunds, disputes, lapses

| Event             | `license_state`        | Online status  | Offline token                                        |
| ----------------- | ---------------------- | -------------- | ---------------------------------------------------- |
| full refund       | `revoked`              | `revoked`      | valid until its `expires`; the documentation says so |
| dispute opened    | `revoked`              | `revoked`      | as above                                             |
| dispute won       | back to Stripe's state | as Stripe says | unchanged                                            |
| partial refund    | `review`               | `active`       | unchanged; operator decides                          |
| subscription ends | `lapsed` after grace   | `lapsed`       | expires with the grace window, by construction       |

Public status answers carry no reason.

## Security requirements

Carried from #2121 and kept: a distinct deploy credential and service from the tile worker; production and sandbox
separated in every binding; secrets only through Wrangler secret bindings and never in git, build output, or logs; the
Stripe API version and SDK pinned; exact-origin CORS and `no-store` on every token-bearing route; rate limits on claim,
refresh, and status; a CI step that scans the worker bundle and its source maps for private-key markers and test-key
prefixes; and a kill switch that stops issuance without stopping verification or refresh.

## Verification

Unit (core): the WebCrypto round trip verifies a token signed by the `node:crypto` implementation it replaces and
produces a byte-identical token for the same key and payload (a fixture token committed before the swap); `lid` and
`agreement` optional-but-required-for-self-service; register derivation yields today's trusted-key map and today's
well-known JSON exactly; the three key states have distinct verdicts. Integration (core): the worker bundle test
resolves `./license/key` and `./license/register` under `workerd,worker,browser` with no `node:` specifier.

Unit (worker): the plan catalog refuses an unknown Price and a mismatched mode; period-end plus grace across a
month boundary, a year boundary, and February 29; the licensee-row-missing path on an early `invoice.paid`; every state
transition in the refunds table; refresh answers the same 404 for unknown lid and wrong secret.

Worker integration (Miniflare): a valid signature over the untouched body passes and a one-byte mutation is a 400; the
same event twice is one token; two events for one invoice in either order are one token; a D1 failure after
verification is a 500 and the event id is not recorded; the claim route answers `pending` before `invoice.paid` and the
same token afterward; CORS admits `SITE_ORIGIN` only; `ISSUANCE_ENABLED=false` refuses the mint and still answers
refresh.

Stripe sandbox end to end: Payment Link → Checkout → webhooks → token; `mailwoman license verify` on the current
release reads `unknown_key` for the sandbox key (the shipped register does not carry it) and `valid` once the test
register is injected, which is the demonstration that trust is release-bound; a card that fails 3DS mints nothing; a
renewal in Stripe's test clock mints a second token with the next period's dates; a refund flips online status; the
email resend under the same invoice id is one message.

Before production issuance is enabled: prerequisites 1 to 5 done; the trust release published; the signing self-test green in production;
the webhook destination subscribed to exactly the listed events; the kill-switch drill performed; alerts on `/health`
failure, on any `email_state = failed` older than an hour, and on reconciliation drift.

## Acceptance

- A customer pays through either Payment Link and, within the webhook's arrival, holds exactly one token whose signed
  payload matches the server-side plan and whose `expires` is the paid period's end plus fourteen days.
- Each renewal mints exactly one new token; `mailwoman license refresh` fetches it; the email carries the same one.
- Replaying, duplicating, or reordering Stripe events never creates a second token for one invoice.
- No token is issued for an unpaid invoice, an unallowlisted Price, or a test-mode event in production.
- A full refund or a dispute makes the license read `revoked` online while the offline token keeps its date, and the
  docs say why.
- A release that predates the shop but trusts the worker's key verifies the token offline.
- Every existing hand-issued token stays valid with no migration.
- Issuance can be disabled in one variable without disabling verification or refresh.

## Out of scope

Seats, resellers, OEM terms, perpetual licenses, coupons, a web account, per-package scopes, and the enterprise tier.
Each keeps the local issuer as its path.

## Issue split

- [ ] **A — Terms and merchant identity** (operator): clickwrap agreement, version scheme, `/license/terms/<version>`,
      Stripe account name.
- [ ] **B — The key format on WebCrypto**: `crypto/ed25519.ts`, the async chain through every caller, `lid` and
      `agreement`, the typed key register that derives the trust map and the well-known JSON, the `./license/key` and
      `./license/register` subpath exports, the worker bundle test.
- [ ] **C — Worker foundation**: workspace, the seven registers, Wrangler environments, D1 schema, deploy workflow,
      signing self-test, kill switch.
- [ ] **D — Fulfilment**: webhook verification, the event handlers, the early-`invoice.paid` path, minting, email.
- [ ] **E — Customer routes**: claim, refresh, status; rate limits; CORS.
- [ ] **F — Site**: Payment Links and portal link on `/license`, the `/license/issued` page, the refresh paragraph.
- [ ] **G — CLI**: `license adopt`, `license refresh`, the config-root key file, `--online` lid status in verify and the
      doctor.
- [ ] **H — Launch**: sandbox end to end, the trust release, production secrets, the kill-switch drill, alerts.
