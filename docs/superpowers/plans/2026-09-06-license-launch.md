# License Launch Plan

> **For agentic workers:** this plan is a runbook with an owner per step, not a sequence of code tasks. The code steps use checkbox (`- [ ]`) syntax; the operator steps are marked and stay open until the operator reports them done.

**Goal:** Sell the first self-service commercial license: the sandbox proves the whole path on Stripe test mode, then production issues under a key a released mailwoman trusts.

**Architecture:** Nothing new is built here. The worker (#2160), the site and CLI (#2162) and the shop registry (`mwops shop`) are complete; launch is provisioning, secrets, one release, one end-to-end run, and the drills the spec requires before `ISSUANCE_ENABLED` flips.

**Spec:** `docs/superpowers/specs/2026-09-05-self-service-commercial-license-design.md`, sections "Prerequisites the code cannot supply", "Key rollout and rotation", "Verification" (the sandbox end-to-end paragraph and the "Before production issuance" paragraph), and issue H of the issue split. Runbook: `packages/license-worker/README.md`.

## Who holds what

| Prerequisite                                                    | Owner                                                                                                           | State on 2026-09-06                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Clickwrap terms page at `/license/terms/commercial-2026-10`     | operator (legal text)                                                                                           | not written                                                               |
| Terms-of-service URL under the Stripe account's public details  | operator (dashboard, no API)                                                                                    | unset; test-mode Payment Links were still created with consent collection |
| Stripe test-mode objects                                        | done: `mwops shop provision --mode test --apply` created six, a second run reads `exists`                       | done                                                                      |
| Stripe live-mode objects                                        | `mwops shop provision --mode live --apply`, needs `MAILWOMAN_STRIPE_LIVE_SECRET_KEY`                            | waiting on the key                                                        |
| Cloudflare token with Workers Scripts, D1 and rate-limit scopes | operator; `CF_AUTH_TOKEN` in `.env` verifies but answers 401/403 on Workers and D1                              | blocked                                                                   |
| Sandbox signing pair                                            | done: `~/.config/mailwoman-sandbox/license/signing-key.pem`, kid `v9-ac522cf3`, in `wrangler.toml` sandbox vars | done                                                                      |
| Production signing pair, registered `active`, released          | operator generates offline; the register entry and release are code steps below                                 | not started                                                               |
| Transactional email account (Resend) and its key                | operator                                                                                                        | not started                                                               |
| Stripe merchant identity matches the licensor in the terms      | operator                                                                                                        | unknown                                                                   |

## Global Constraints

- Live-mode writes go through `mwops shop provision --mode live`, which reads `MAILWOMAN_STRIPE_LIVE_SECRET_KEY` and refuses any key that is not `sk_live_`. No live object is created by hand.
- Secrets enter the worker only through `wrangler secret put`. The webhook signing secret appears once, in the provisioning report, and is stored the same minute.
- Production deploys with `ISSUANCE_ENABLED = "false"` and flips only after the checklist at the end.
- The sandbox key never enters the register; the production key enters it as `active` and ships in a release before any live sale.

---

### Task 1 (operator): the Cloudflare credentials

- [ ] Create an API token scoped to the account with Workers Scripts (edit), D1 (edit) and Workers Rate Limiting, and put it in the lab `.env` as `CLOUDFLARE_API_TOKEN` beside `CLOUDFLARE_ACCOUNT_ID`, or run `wrangler login` on the lab host. The same token goes into the two GitHub environments `license-worker-sandbox` and `license-worker-production` for `.github/workflows/license-worker.yml`.

### Task 2: the sandbox worker

**Files:** `packages/license-worker/wrangler.toml` (sandbox `database_id`)

- [ ] **Step 1:** create the sandbox D1 and the three rate-limit namespaces; write the database id into `[env.sandbox.d1_databases]`.

```bash
yarn workspace @mailwoman/license-worker wrangler d1 create mailwoman-license-sandbox
```

- [ ] **Step 2:** secrets for the sandbox: the test-mode `STRIPE_SECRET_KEY` (from `MAILWOMAN_STRIPE_SECRET_KEY`), `LICENSE_SIGNING_KEY_PEM` from `~/.config/mailwoman-sandbox/license/signing-key.pem`, `EMAIL_API_KEY` (a Resend test key, or a placeholder until Task 6: a failed send is recorded and re-sent by reconciliation).

```bash
yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_SECRET_KEY --env sandbox
yarn workspace @mailwoman/license-worker wrangler secret put LICENSE_SIGNING_KEY_PEM --env sandbox
yarn workspace @mailwoman/license-worker wrangler secret put EMAIL_API_KEY --env sandbox
```

- [ ] **Step 3:** deploy with migrations, and read `/health`.

```bash
yarn workspace @mailwoman/license-worker migrate:sandbox
yarn workspace @mailwoman/license-worker deploy:sandbox
curl -s https://mailwoman-license-sandbox.<account>.workers.dev/health
```

Expected: `{"issuance":false,"liveMode":false,"signing":"ok","ledger":"ok"}`. `signing: ok` here is the worker trusting its own sandbox key.

- [ ] **Step 4:** the webhook destination against the deployed origin, then its secret.

```bash
yarn mwops shop provision --mode test --apply --worker-origin https://mailwoman-license-sandbox.<account>.workers.dev
yarn workspace @mailwoman/license-worker wrangler secret put STRIPE_WEBHOOK_SECRET --env sandbox
```

- [ ] **Step 5:** set `ISSUANCE_ENABLED = "true"` in `[env.sandbox.vars]`, redeploy, commit the wrangler changes.

### Task 3: the sandbox end to end

- [ ] **Step 1:** open the test-mode monthly Payment Link from the provisioning report in a browser, pay with card `4242 4242 4242 4242`, any future expiry, any CVC, a licensee legal name in the custom field, accept the terms. Stripe redirects to `https://mailwoman.ai/license/issued?session_id=cs_test_…`; the deployed site runs #2162's page and polls `license.mailwoman.ai`, which does not exist yet, so read the session id from the URL and claim it from the sandbox by hand:

```bash
curl -s https://mailwoman-license-sandbox.<account>.workers.dev/v1/checkout-sessions/cs_test_…/license
```

Expected within seconds of the redirect: `{"status":"issued","token":"mwl1.…","lid":"lic_…","licensee":"…","issued":"…","expires":"…","refresh_secret":"…"}`; a second call answers the same without `refresh_secret`.

- [ ] **Step 2:** verify the token offline against the sandbox public key, which no release trusts:

```bash
MAILWOMAN_LICENSE_URL=https://mailwoman-license-sandbox.<account>.workers.dev node packages/mailwoman/out/cli.js license verify --key "mwl1.…" --online
```

Expected: `status: unknown_key` (the shipped register does not carry `v9-ac522cf3`) and `license lic_…: active`. That pair of lines is the spec's demonstration that trust is release-bound. Then, in a script, `verifyLicenseKey(token, { trustedKeys: { "v9-ac522cf3": <sandbox public PEM> } })` reads `valid` with `expires` = the period end plus 14 days.

- [ ] **Step 3:** `mailwoman license refresh --lid lic_… --secret …` against the sandbox reads `Not written: this release does not trust key id v9-ac522cf3`, exit 1: the refusal is the CLI holding the same line.
- [ ] **Step 4:** a renewal under a Stripe test clock mints a second token with the next period's dates: `yarn mwops shop rehearse` prints a Checkout Session for a test-clock customer, pay it with the test card, then `yarn mwops shop rehearse-renewal --session cs_test_… --worker-origin https://mailwoman-license-sandbox.<account>.workers.dev` advances the clock and reports both tokens' dates with `agrees: true`. A full refund in the dashboard flips `/v1/license-status` to `revoked`; the reconciliation cron's log names the ids only.
- [ ] **Step 5:** the kill-switch drill: `ISSUANCE_ENABLED = "false"`, redeploy, pay again; the webhook answers 200 with `refused: issuance is disabled`, the claim reads `pending`, refresh still answers; flip back, and the next reconciliation mints the missed invoice.

### Task 4: the production signing key and the trust release

**Files:** `packages/core/lib/license/register.ts`, `docs/static/.well-known/mailwoman/license-keys.json`

- [ ] **Step 1 (operator):** generate the pair offline with `mailwoman license keygen` under a config root that is not the lab's, and keep the private half off every machine but the one that runs `wrangler secret put`.
- [ ] **Step 2:** add the public half to `LICENSE_SIGNING_KEYS` as `active`; run `mailwoman license register --write`; the `license-register` health check holds the well-known file to the register. Open the PR; merge; publish the release (`RELEASING.md`).
- [ ] **Step 3:** confirm the published tarball and `https://mailwoman.ai/.well-known/mailwoman/license-keys.json` both carry the new kid.

### Task 5 (operator): terms, merchant identity, live Stripe

- [ ] The clickwrap agreement as `docs/src/pages/license/terms/commercial-2026-10.mdx`, never edited after publication; a new version is a new page and a new `AGREEMENT_VERSION` in `lib/shop/catalog.ts`.
- [ ] The Stripe account's legal name matches the licensor the terms name; the terms URL under the account's public details.
- [ ] `MAILWOMAN_STRIPE_LIVE_SECRET_KEY` in the lab `.env`, then `yarn mwops shop provision --mode live --apply`, which writes the production Price ids into `wrangler.toml` and the Payment Links into `docs/src/license/shop.ts`. Commit both; the Buy section renders on the next site deploy. Add `BILLING_PORTAL_URL` (the no-code portal's login link from the dashboard) to `shop.ts` by hand: it is not an API object.

### Task 6 (operator): the email account

- [ ] A Resend account with `licenses@mailwoman.ai` as a verified sender; its key is `EMAIL_API_KEY` in both environments.

### Task 7: production

- [ ] Steps 1 to 8 of the README's "First deploy" against `--env production`, with the trust release published first (Task 4) and `ISSUANCE_ENABLED = "false"` throughout.
- [ ] Alerts: on `/health` answering anything but 200, on any `email_state = failed` older than an hour, and on a reconciliation report with a non-empty `failed` list. Cloudflare's health check plus a Logpush query on the worker log cover the three.
- [ ] The kill-switch drill once in production with a live card refunded afterwards, then `ISSUANCE_ENABLED = "true"`.

## Acceptance

The spec's acceptance list, run against production with the first real purchase: one token per paid invoice with `expires` at the period end plus 14 days; a renewal mints one new token that `mailwoman license refresh` fetches; replayed events mint nothing; a refund reads `revoked` online while the offline token keeps its date; a release that predates the shop but trusts the key verifies the token; every hand-issued token still verifies; issuance stops in one variable.
