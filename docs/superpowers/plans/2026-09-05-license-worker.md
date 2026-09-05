# License Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in one session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private Cloudflare Worker, `packages/license-worker/`, that verifies Stripe webhooks, mints a signed license token on every paid invoice, keeps the ledger in D1, and answers the claim, refresh, and status routes, with every path covered by tests that run under the Workers runtime.

## Execution notes

The plan below is the text the work started from. Where the code that landed differs, this section is the record; the
task bodies are left as written.

- **No `fetchMock`.** `@cloudflare/vitest-pool-workers` 0.22 exports none. The Stripe client takes a fetch
  implementation (`stripeClient(env, fetchImplementation)`), and `test/support/stripe-mock.ts` exports `stripeFetch(routes)`,
  a fetch that answers by method and path prefix and 404s anything else, which the SDK raises as an error.
- **`env` comes from `cloudflare:workers`.** The pool deprecates `env` from `cloudflare:test`. `test/support/env.d.ts`
  declares `Cloudflare.Env` as the worker's bindings plus `TEST_MIGRATIONS`, and `tsconfig.test.json` carries the pool's
  `cloudflare:test` types, so no test casts `env`.
- **A charge no longer names its invoice.** Under the pinned API the link runs `charge.payment_intent` →
  `invoicePayments.list({ payment: { type: "payment_intent", payment_intent } })` → `data[0].invoice`
  (`invoiceIDForCharge` in `lib/stripe/handlers.ts`).
- **The claim route re-reads an unseen session.** A Checkout Session the ledger has not seen is retrieved from Stripe by
  id and its license row created there, so the success page never depends on webhook order; only a session Stripe does
  not know is a 404.
- **`takePendingRefreshSecret` is a read and a conditional clear.** `RETURNING` on the update alone answers the cleared
  column, which is null.
- **Reconciliation has a third sweep and a `failed` list.** Every license is compared with its subscription's current
  state; a dispute Stripe has ruled `won` hands a revoked license back to its subscription's state; a license whose
  Stripe records cannot be read is reported by id and never stops the sweep.
- **The webhook checks `eventRecorded` first, runs the handler, then `recordEventOnce`.** The order the Task 6 body
  argues for, with the pre-check named.
- **The deploy workflow refuses a `node:` import** from the dry-run bundle before deploying. Measured 2.1 MB, zero hits.

**Architecture:** A Hono app on `@hono/zod-openapi`, the same route idiom as the drop-in servers, exported as the Worker's `fetch` handler, plus a `scheduled` handler for reconciliation. Stripe's SDK runs on `fetch` and WebCrypto. The ledger is three D1 tables written under unique constraints, so Stripe's at-least-once, unordered delivery is idempotent without a queue. Signing calls `encodeLicenseKey` from `@mailwoman/core/license/key`, which the bundle test on `main` already proves `node:`-free. Tests run under `@cloudflare/vitest-pool-workers` with Miniflare's D1 and a fetch stub handed to the Stripe SDK standing in for `api.stripe.com`.

**Tech Stack:** TypeScript, Hono 4.13 + `@hono/zod-openapi` 1.6, `stripe` 22.6 (`Stripe.createFetchHttpClient()`, `Stripe.createSubtleCryptoProvider()`), Kysely over `kysely-d1`, wrangler 4.129, `@cloudflare/vitest-pool-workers` 0.22, `@cloudflare/workers-types` 5.

**Spec:** `docs/superpowers/specs/2026-09-05-self-service-commercial-license-design.md`, sections "The worker", "Refunds, disputes, lapses", "Security requirements", and the worker rows of "Verification". This plan is issues C, D and E of the spec's split. Issue B (the key format) is merged as #2158.

## Global Constraints

- The worker imports four core subpaths and NOTHING else from core: `@mailwoman/core/license/key`, `@mailwoman/core/license/register`, `@mailwoman/core/crypto/base64url`, `@mailwoman/core/crypto/digest`. No barrel, no `#env`, no `fs`. The worker bundle test in core holds those two subpaths `node:`-free; the worker's own `wrangler deploy --dry-run` in Task 9 is the check that the worker's whole graph is.
- No `nodejs_compat` flag. Every dependency must run on the Workers runtime as shipped: Stripe's SDK does through its fetch client and SubtleCrypto provider; `kysely` and `kysely-d1` are pure JS; Hono is web-standard.
- Secrets arrive through Wrangler secret bindings only: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LICENSE_SIGNING_KEY_PEM`, `EMAIL_API_KEY`. None appears in `wrangler.toml`, in a test fixture that ships, in a log line, or in a response. `.dev.vars` is gitignored (confirm: `git check-ignore -q packages/license-worker/.dev.vars`; add the pattern to `.gitignore` if it is not).
- Production and sandbox are two Wrangler environments with separate D1 databases, secrets, key ids, Price IDs, and site origins. A sandbox signing key never enters the register in core.
- Every event id is written in the same D1 batch as its effects. A duplicate event id is a 200 with no effect. Any failure after signature verification is a 500, so Stripe retries. A bad signature is a 400 and is not retried.
- The webhook handler never trusts an event body's fields for entitlement: it retrieves the invoice, the subscription, and when needed the Checkout Session from Stripe by id.
- `Cache-Control: no-store` on every route that can carry a token. CORS admits exactly `SITE_ORIGIN` on the claim route and nothing on the others.
- Money and time: `expires` is the subscription period end plus `graceDays` (14) as an inclusive UTC calendar date; `issued` is the invoice's paid date as a UTC calendar date. Both are persisted before signing so a retry reproduces the same payload.
- Relative imports carry `.ts`; sibling modules go through `#*`. No `enum`. Comments state invariants. Acronym casing: `ID`, `URL`, `PEM`, `D1` (`D1Database` is Cloudflare's own name and stays).
- The worker is a new workspace and joins the registers AGENTS.md lists: root `workspaces`; both root `tsconfig.json` references; `SANCTIONED_RELEASE_ABSENCES` (reason: private infrastructure); `knip.json` workspace entry. It is private, so the release list, `bless-package`, and the smoke pack set do not apply. `checkReleaseListIdentity`'s `publishCount` pin stays 59.
- The worker's tests run under their own vitest config; the root sweep excludes them the way it excludes `@mailwoman/react`'s browser tests, and CI runs them as their own step.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg`.
- Work happens on branch `feat/license-worker` in the worktree `.claude/worktrees/license-posture`. The worktree Bash guard refuses `cat >>` heredocs, computed arguments, and the word `eval`; use `python3 - <<'EOF'` heredocs or the Edit/Write tools.

---

## File map

| File                                                                                                                                             | Responsibility                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/license-worker/package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `wrangler.toml`, `.dev.vars.example`          | the workspace and its two environments                                                                                            |
| `packages/license-worker/migrations/0001_ledger.sql`                                                                                             | the three tables, applied by `wrangler d1 migrations apply`                                                                       |
| `packages/license-worker/lib/env.ts`                                                                                                             | the typed bindings: secrets, vars, the D1 binding, the rate limiters; zod-validated once per isolate                              |
| `packages/license-worker/lib/plans.ts`                                                                                                           | the closed plan catalog: two Price IDs to two plan codes                                                                          |
| `packages/license-worker/lib/ledger/schema.ts`                                                                                                   | the Kysely `Database` interface for the three tables                                                                              |
| `packages/license-worker/lib/ledger/client.ts`                                                                                                   | `openLedger(env)`: Kysely over `kysely-d1`                                                                                        |
| `packages/license-worker/lib/ledger/licenses.ts`                                                                                                 | typed reads and writes: `recordEvent`, `upsertLicense`, `mintToken`, `currentToken`, state transitions                            |
| `packages/license-worker/lib/stripe/client.ts`                                                                                                   | `stripeClient(env)` on the fetch HTTP client                                                                                      |
| `packages/license-worker/lib/stripe/webhook.ts`                                                                                                  | `verifyStripeEvent(request, env)` on the SubtleCrypto provider; the event-type allowlist                                          |
| `packages/license-worker/lib/stripe/handlers.ts`                                                                                                 | one handler per event type                                                                                                        |
| `packages/license-worker/lib/fulfil.ts`                                                                                                          | `fulfilInvoice(...)`: retrieve, check, compute dates, mint, persist, email                                                        |
| `packages/license-worker/lib/dates.ts`                                                                                                           | `calendarDateUTC(seconds)`, `plusDays(date, n)`                                                                                   |
| `packages/core/lib/crypto/digest.ts` (create, Task 0)                                                                                            | `sha256Bytes`, `hexOf`: the WebCrypto digest and its hex form, which `crypto/ed25519.ts`, `license/key.ts` and the worker all use |
| `packages/license-worker/lib/identifiers.ts`                                                                                                     | `newLicenseID()`, `newRefreshSecret()`, `secretDigest(text)`                                                                      |
| `packages/license-worker/lib/signing.ts`                                                                                                         | `signingSelfTest(env)`: the private key matches `LICENSE_SIGNING_KID` and an `active` register entry                              |
| `packages/license-worker/lib/email/provider.ts`, `resend.ts`                                                                                     | the `EmailProvider` interface and the one implementation                                                                          |
| `packages/license-worker/lib/routes/webhook.ts`, `claim.ts`, `refresh.ts`, `status.ts`, `health.ts`                                              | the routes                                                                                                                        |
| `packages/license-worker/lib/app.ts`                                                                                                             | `createLicenseWorkerApp(env)`: Hono app, CORS, `no-store`, the routes                                                             |
| `packages/license-worker/lib/index.ts`                                                                                                           | the Worker export: `fetch` and `scheduled`                                                                                        |
| `packages/license-worker/lib/reconcile.ts`                                                                                                       | the scheduled pass                                                                                                                |
| `packages/license-worker/test/**`                                                                                                                | unit tests under the Workers pool; `test/support/stripe-fixtures.ts` and `test/support/stripe-mock.ts`                            |
| `.github/workflows/license-worker.yml`                                                                                                           | manual dispatch: `wrangler deploy --env <sandbox                                                                                  | production>` |
| root `package.json`, `tsconfig.json`, `knip.json`, `vitest.config.ts`, `.github/workflows/test.yml`, `packages/release-kit/lib/release/stage.ts` | the registers                                                                                                                     |

---

### Task 0: The WebCrypto digest gets its own home in core

**Files:**

- Create: `packages/core/lib/crypto/digest.ts`
- Modify: `packages/core/lib/crypto/ed25519.ts` (drop `sha256Bytes`), `packages/core/lib/license/key.ts` (drop the local `hex`; import `hexOf` and `sha256Bytes` from the digest module), `packages/core/package.json` (`./crypto/digest` export), `packages/core/test/unit/crypto/ed25519.test.ts` (import the digest from its home)
- Test: `packages/core/test/unit/crypto/digest.test.ts`

`sha256Bytes` sits in `ed25519.ts` today because the key id needed it; the worker needs the same digest for the refresh secret, and a third copy would be the duplicate the review of #2153 refused. One module, three importers.

- [x] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/crypto/digest.test.ts
import { hexOf, sha256Bytes } from "@mailwoman/core/crypto/digest"
import { expect, it } from "vitest"

it("digests to the SHA-256 test vector and renders lowercase hex", async () => {
	expect(hexOf(await sha256Bytes(new TextEncoder().encode("abc")))).toBe(
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	)
	expect(hexOf(new Uint8Array([0, 15, 255]))).toBe("000fff")
})
```

- [x] **Step 2: Implement**

```ts
// packages/core/lib/crypto/digest.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SHA-256 on `crypto.subtle` and the hex rendering of a byte string: the digest the license key id, the register and
 *   the license worker share. `@mailwoman/core/hash` keeps the synchronous `node:crypto` digests for files and build
 *   scripts; this module is the one a Worker or a browser can import.
 */

export async function sha256Bytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data))
}

export function hexOf(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
```

Remove `sha256Bytes` from `ed25519.ts` and import it from `#crypto/digest` where it was used (`key.ts` and the Ed25519 test); remove `hex` from `key.ts` and import `hexOf`. Add the `./crypto/digest` export beside `./crypto/ed25519`.

- [x] **Step 3: Run, lint, commit**

Run: `yarn compile`, then `yarn vitest run packages/core/test/unit/crypto packages/core/test/unit/license packages/core/test/integration/worker-bundle.test.ts`. Expected: PASS. Commit as `refactor(core): the WebCrypto digest has one home, crypto/digest, for the key id and the worker alike`.

---

### Task 1: The workspace, its registers, and an empty Worker that answers `/health`

**Files:**

- Create: `packages/license-worker/package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `wrangler.toml`, `.dev.vars.example`, `lib/index.ts`, `lib/app.ts`, `lib/env.ts`, `lib/routes/health.ts`
- Modify: root `package.json` (`workspaces`, a `test:license-worker` script), root `tsconfig.json` (two references), `knip.json`, root `vitest.config.ts` (exclude), `packages/release-kit/lib/release/stage.ts` (absence), `.github/workflows/test.yml` (a step)
- Test: `packages/license-worker/test/health.test.ts`

**Interfaces produced:**

```ts
// lib/env.ts
export interface LicenseWorkerBindings {
	DB: D1Database
	STRIPE_SECRET_KEY: string
	STRIPE_WEBHOOK_SECRET: string
	LICENSE_SIGNING_KEY_PEM: string
	EMAIL_API_KEY: string
	LICENSE_SIGNING_KID: string
	STRIPE_PRICE_MONTHLY: string
	STRIPE_PRICE_YEARLY: string
	AGREEMENT_VERSION: string
	ISSUANCE_ENABLED: string // "true" | "false"; vars are strings
	SITE_ORIGIN: string
	EMAIL_FROM: string
	STRIPE_LIVE_MODE: string // "true" in production, "false" in sandbox
	CLAIM_LIMITER: RateLimit
	REFRESH_LIMITER: RateLimit
	STATUS_LIMITER: RateLimit
}
export interface LicenseWorkerEnv extends LicenseWorkerBindings {
	readonly issuanceEnabled: boolean
	readonly liveMode: boolean
}
export function readEnv(bindings: LicenseWorkerBindings): LicenseWorkerEnv // zod, throws on a missing var
// lib/app.ts
export function createLicenseWorkerApp(env: LicenseWorkerEnv): OpenAPIHono
```

- [x] **Step 1: Write the failing test**

```ts
// packages/license-worker/test/health.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:test"
import { expect, test } from "vitest"

import { createLicenseWorkerApp } from "#app"
import { readEnv } from "#env"

test("GET /health answers issuance, the environment's mode, and no-store", async () => {
	const app = createLicenseWorkerApp(readEnv(env))
	const res = await app.request("/health")

	expect(res.status).toBe(200)
	expect(res.headers.get("cache-control")).toBe("no-store")
	expect(await res.json()).toMatchObject({ issuance: false, liveMode: false, signing: "unchecked" })
})
```

- [x] **Step 2: Create the workspace**

`packages/license-worker/package.json`:

```json
{
	"name": "@mailwoman/license-worker",
	"version": "0.0.0",
	"private": true,
	"description": "The self-service license worker: Stripe webhooks in, signed license tokens out, ledger in D1.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"contributors": [{ "name": "Teffen Ellis", "email": "teffen@sister.software" }],
	"type": "module",
	"imports": {
		"#*": {
			"node": "./lib/*.ts",
			"default": "./out/*.js",
			"types": "./out/*.d.ts"
		}
	},
	"exports": {
		"./package.json": "./package.json"
	},
	"scripts": {
		"dev": "wrangler dev --env sandbox",
		"deploy:sandbox": "wrangler deploy --env sandbox",
		"deploy:production": "wrangler deploy --env production",
		"migrate:sandbox": "wrangler d1 migrations apply LICENSE_LEDGER --env sandbox --remote",
		"migrate:production": "wrangler d1 migrations apply LICENSE_LEDGER --env production --remote",
		"test": "vitest run"
	},
	"dependencies": {
		"@hono/zod-openapi": "^1.6.3",
		"@mailwoman/core": "workspace:*",
		"hono": "^4.13.7",
		"kysely": "^0.28.0",
		"kysely-d1": "^0.4.0",
		"stripe": "^22.6.1",
		"zod": "^4.5.4"
	},
	"devDependencies": {
		"@cloudflare/vitest-pool-workers": "^0.22.0",
		"@cloudflare/workers-types": "^5.20260905.1",
		"vitest": "*",
		"wrangler": "^4.129.0"
	},
	"engines": { "node": ">=24.18.0" }
}
```

Pin `kysely` to the version the repo already uses (`grep -n '"kysely"' packages/sqlite/package.json`) and `vitest` to the root's. `kysely-d1`'s current version: `npm view kysely-d1 version` at execution.

`tsconfig.json` copies `packages/tile-worker/tsconfig.json` with `"references": [{ "path": "../core" }]` and `"types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]`. `tsconfig.test.json` copies a sibling's (`packages/api-kit/tsconfig.test.json`).

`vitest.config.ts`:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig({
	test: {
		include: ["test/**/*.test.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.toml", environment: "sandbox" },
				miniflare: {
					// Test values for every var; secrets come from .dev.vars in a dev run and from these in tests.
					bindings: {
						STRIPE_SECRET_KEY: "sk_test_placeholder",
						STRIPE_WEBHOOK_SECRET: "whsec_test_placeholder",
						LICENSE_SIGNING_KEY_PEM: "",
						EMAIL_API_KEY: "re_test_placeholder",
					},
				},
			},
		},
	},
})
```

`wrangler.toml`:

```toml
name = "mailwoman-license"
main = "./lib/index.ts"
compatibility_date = "2026-09-01"

[triggers]
crons = ["0 */6 * * *"]

[vars]
ISSUANCE_ENABLED = "false"
SITE_ORIGIN = "https://mailwoman.ai"
AGREEMENT_VERSION = "commercial-2026-10"
EMAIL_FROM = "licenses@mailwoman.ai"

[env.sandbox]
name = "mailwoman-license-sandbox"
[env.sandbox.vars]
ISSUANCE_ENABLED = "false"
SITE_ORIGIN = "https://mailwoman.ai"
AGREEMENT_VERSION = "commercial-2026-10"
EMAIL_FROM = "licenses@mailwoman.ai"
STRIPE_LIVE_MODE = "false"
LICENSE_SIGNING_KID = "v9-sandbox0"
STRIPE_PRICE_MONTHLY = "price_sandbox_monthly"
STRIPE_PRICE_YEARLY = "price_sandbox_yearly"
[[env.sandbox.d1_databases]]
binding = "LICENSE_LEDGER"
database_name = "mailwoman-license-sandbox"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"
[[env.sandbox.ratelimits]]
name = "CLAIM_LIMITER"
namespace_id = "1001"
simple = { limit = 30, period = 60 }
[[env.sandbox.ratelimits]]
name = "REFRESH_LIMITER"
namespace_id = "1002"
simple = { limit = 10, period = 60 }
[[env.sandbox.ratelimits]]
name = "STATUS_LIMITER"
namespace_id = "1003"
simple = { limit = 60, period = 60 }

[env.production]
name = "mailwoman-license"
routes = [{ pattern = "license.mailwoman.ai", custom_domain = true }]
[env.production.vars]
ISSUANCE_ENABLED = "false"
SITE_ORIGIN = "https://mailwoman.ai"
AGREEMENT_VERSION = "commercial-2026-10"
EMAIL_FROM = "licenses@mailwoman.ai"
STRIPE_LIVE_MODE = "true"
LICENSE_SIGNING_KID = "REPLACE-WITH-THE-WORKER-KEY-ID"
STRIPE_PRICE_MONTHLY = "REPLACE"
STRIPE_PRICE_YEARLY = "REPLACE"
[[env.production.d1_databases]]
binding = "LICENSE_LEDGER"
database_name = "mailwoman-license"
database_id = "REPLACE"
migrations_dir = "migrations"
[[env.production.ratelimits]]
name = "CLAIM_LIMITER"
namespace_id = "2001"
simple = { limit = 30, period = 60 }
[[env.production.ratelimits]]
name = "REFRESH_LIMITER"
namespace_id = "2002"
simple = { limit = 10, period = 60 }
[[env.production.ratelimits]]
name = "STATUS_LIMITER"
namespace_id = "2003"
simple = { limit = 60, period = 60 }
```

The `REPLACE` values are what the operator fills when the Stripe objects and the D1 database exist; `readEnv` refuses them (Task 3) so a deploy with a placeholder answers 503, never mints. The D1 binding is named `LICENSE_LEDGER`, not `DB`, so a grep for it finds only this worker.

`.dev.vars.example`:

```
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
LICENSE_SIGNING_KEY_PEM="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
EMAIL_API_KEY=re_…
```

- [x] **Step 3: Write `env.ts`, `app.ts`, `routes/health.ts`, `index.ts`**

```ts
// lib/env.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's bindings, read once per isolate and refused when a var still carries a placeholder. Vars are strings
 *   in Wrangler; the two booleans are parsed here so no route compares a string to "true".
 */

import { z } from "zod"

export interface LicenseWorkerBindings {
	LICENSE_LEDGER: D1Database
	STRIPE_SECRET_KEY: string
	STRIPE_WEBHOOK_SECRET: string
	LICENSE_SIGNING_KEY_PEM: string
	EMAIL_API_KEY: string
	LICENSE_SIGNING_KID: string
	STRIPE_PRICE_MONTHLY: string
	STRIPE_PRICE_YEARLY: string
	AGREEMENT_VERSION: string
	ISSUANCE_ENABLED: string
	SITE_ORIGIN: string
	EMAIL_FROM: string
	STRIPE_LIVE_MODE: string
	CLAIM_LIMITER: RateLimit
	REFRESH_LIMITER: RateLimit
	STATUS_LIMITER: RateLimit
}

const notPlaceholder = z
	.string()
	.min(1)
	.refine((value) => !value.startsWith("REPLACE"), "placeholder value")

const VarsSchema = z.object({
	LICENSE_SIGNING_KID: notPlaceholder,
	STRIPE_PRICE_MONTHLY: notPlaceholder,
	STRIPE_PRICE_YEARLY: notPlaceholder,
	AGREEMENT_VERSION: notPlaceholder,
	ISSUANCE_ENABLED: z.enum(["true", "false"]),
	SITE_ORIGIN: z.string().url(),
	EMAIL_FROM: z.string().email(),
	STRIPE_LIVE_MODE: z.enum(["true", "false"]),
})

export interface LicenseWorkerEnv extends LicenseWorkerBindings {
	readonly issuanceEnabled: boolean
	readonly liveMode: boolean
}

/**
 * Validate the vars and derive the two booleans. Throws on a placeholder, which the Worker's `fetch` turns into a 503 —
 * a deploy with an unfilled var must refuse, never mint.
 */
export function readEnv(bindings: LicenseWorkerBindings): LicenseWorkerEnv {
	const vars = VarsSchema.parse(bindings)

	return {
		...bindings,
		issuanceEnabled: vars.ISSUANCE_ENABLED === "true",
		liveMode: vars.STRIPE_LIVE_MODE === "true",
	}
}
```

```ts
// lib/routes/health.ts
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"

const HealthSchema = z.object({
	issuance: z.boolean(),
	liveMode: z.boolean(),
	signing: z.enum(["ok", "mismatch", "unchecked"]),
})

const healthRoute = createRoute({
	method: "get",
	path: "/health",
	responses: {
		200: {
			description: "Issuance switch, mode, and the signing self-test's last result.",
			content: { "application/json": { schema: HealthSchema } },
		},
	},
})

export function registerHealthRoute(
	app: OpenAPIHono,
	env: LicenseWorkerEnv,
	signing: () => "ok" | "mismatch" | "unchecked"
): void {
	app.openapi(healthRoute, (c) =>
		c.json({ issuance: env.issuanceEnabled, liveMode: env.liveMode, signing: signing() }, 200)
	)
}
```

```ts
// lib/app.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license worker's Hono app. Every response is `no-store`: nothing this worker answers may be cached by a proxy,
 *   because the claim and refresh routes carry tokens and the status route carries a verdict that revocation changes.
 */

import { OpenAPIHono } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"
import { registerHealthRoute } from "#routes/health"

export interface AppDependencies {
	signingStatus: () => "ok" | "mismatch" | "unchecked"
}

export function createLicenseWorkerApp(
	env: LicenseWorkerEnv,
	deps: AppDependencies = { signingStatus: () => "unchecked" }
): OpenAPIHono {
	const app = new OpenAPIHono()

	app.use(async (c, next) => {
		c.header("Cache-Control", "no-store")
		await next()
	})

	app.onError((error, c) => {
		console.error(error instanceof Error ? error.message : String(error))

		return c.json({ error: "internal error" }, 500)
	})

	registerHealthRoute(app, env, deps.signingStatus)

	return app
}
```

```ts
// lib/index.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Worker export. `readEnv` runs per request and is cheap; a placeholder var answers 503 for every request rather
 *   than letting one route work and another mint.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"

import { createLicenseWorkerApp } from "#app"
import { type LicenseWorkerBindings, readEnv } from "#env"

const handler: ExportedHandler<LicenseWorkerBindings> = {
	async fetch(request, bindings) {
		let env

		try {
			env = readEnv(bindings)
		} catch {
			return new Response(JSON.stringify({ error: "worker misconfigured" }), {
				status: 503,
				headers: { "content-type": "application/json", "cache-control": "no-store" },
			})
		}

		return createLicenseWorkerApp(env).fetch(request as unknown as Request)
	},
}

export default handler
```

The `request as unknown as Request` cast reconciles `@cloudflare/workers-types`' `Request` with the DOM-typed one Hono declares; if the two unify under the installed types, drop the cast.

- [x] **Step 4: Register the workspace**

- Root `package.json` `workspaces`: add `"packages/license-worker"` in alphabetical position. Add a script `"test:license-worker": "yarn workspace @mailwoman/license-worker test"`.
- Root `tsconfig.json`: add `{ "path": "./packages/license-worker" }` and `{ "path": "./packages/license-worker/tsconfig.test.json" }` beside the tile-worker entry.
- `knip.json`: `"packages/license-worker": { "entry": ["lib/index.ts", "test/**/*.ts"] }` (vitest-pool-workers imports `cloudflare:test`, which knip does not know; add `"ignoreDependencies": ["@cloudflare/vitest-pool-workers"]` if knip reports it unused).
- `packages/release-kit/lib/release/stage.ts` `SANCTIONED_RELEASE_ABSENCES`: `"packages/license-worker": "private license worker — Cloudflare infrastructure, never publishes"`.
- Root `vitest.config.ts` `exclude`: `"**/license-worker/**/*.test.ts"` with a comment in the shape of the react one: the tests import `cloudflare:test` and run under the Workers pool via the workspace's own `vitest.config.ts`; CI runs them as their own step.
- `.github/workflows/test.yml`: add a step after the react browser step that runs `yarn test:license-worker` (read the react step and copy its shape; the Workers pool needs no browser).

Run `yarn install` (the lockfile changes; commit it).

- [x] **Step 5: Run the test**

Run: `yarn workspace @mailwoman/license-worker test`
Expected: PASS, 1 test. If `cloudflare:test` fails to resolve, the pool did not install; check `yarn why @cloudflare/vitest-pool-workers`.

Then `yarn tsc -b packages/license-worker` (or `yarn compile`) and `yarn health:architecture`, and the release-stage identity: `yarn vitest run packages/release-kit/test/integration/release-stage.test.ts` (the `publishCount` pin stays 59; the absence set grows by one).

- [x] **Step 6: Commit**

```bash
git add packages/license-worker package.json tsconfig.json knip.json vitest.config.ts yarn.lock packages/release-kit/lib/release/stage.ts .github/workflows/test.yml
git commit -m "feat(license-worker): the workspace, two Wrangler environments, and a Worker that answers /health under the Workers test pool

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 2: The ledger — D1 migration, Kysely schema, and typed access

**Files:**

- Create: `packages/license-worker/migrations/0001_ledger.sql`, `lib/ledger/schema.ts`, `lib/ledger/client.ts`, `lib/ledger/licenses.ts`
- Test: `packages/license-worker/test/ledger.test.ts`

**Interfaces produced:**

```ts
export const LicenseState = { Active: "active", Lapsed: "lapsed", Revoked: "revoked", Review: "review" } as const
export type LicenseState = (typeof LicenseState)[keyof typeof LicenseState]
export interface LicenseRow {
	lid
	subscription_id
	customer_id
	plan_code
	agreement_version
	licensee
	email
	refresh_secret_sha256
	subscription_state
	payment_state
	license_state: LicenseState
	created_at
	updated_at
}
export interface LicenseTokenRow {
	invoice_id
	lid
	issued
	expires
	payload_json
	token
	email_state: "sent" | "failed" | "pending"
	email_message_id: string | null
	created_at
}
export interface StripeEventRow {
	event_id
	type
	object_id
	received_at
	outcome
}
export function openLedger(db: D1Database): Kysely<LedgerDatabase>
export async function recordEventOnce(ledger, event: { id; type; objectID }): Promise<"recorded" | "duplicate">
export async function findLicenseBySubscription(ledger, subscriptionID): Promise<LicenseRow | undefined>
export async function findLicense(ledger, lid): Promise<LicenseRow | undefined>
export async function createLicense(ledger, row: NewLicense): Promise<void>
export async function setLicenseState(
	ledger,
	lid,
	state: LicenseState,
	subscriptionState?: string,
	paymentState?: string
): Promise<void>
export async function findToken(ledger, invoiceID): Promise<LicenseTokenRow | undefined>
export async function insertToken(ledger, row: NewToken): Promise<void>
export async function currentToken(ledger, lid): Promise<LicenseTokenRow | undefined> // latest `expires`
export async function setEmailState(ledger, invoiceID, state, messageID?): Promise<void>
export async function findTokenByCheckoutSession(
	ledger,
	sessionID
): Promise<{ license: LicenseRow; token: LicenseTokenRow } | undefined>
```

- [x] **Step 1: Write the failing test**

```ts
// packages/license-worker/test/ledger.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:test"
import { beforeEach, expect, test } from "vitest"

import { openLedger } from "#ledger/client"
import {
	createLicense,
	currentToken,
	findLicenseBySubscription,
	insertToken,
	LicenseState,
	recordEventOnce,
	setLicenseState,
} from "#ledger/licenses"
import { applyMigrations } from "./support/migrations.ts"

beforeEach(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

const license = {
	lid: "lic_test000000000000000001",
	subscription_id: "sub_1",
	customer_id: "cus_1",
	checkout_session_id: "cs_test_1",
	plan_code: "commercial-monthly-v1",
	agreement_version: "commercial-2026-10",
	licensee: "Example Ltd",
	email: "ops@example.com",
	refresh_secret_sha256: "0".repeat(64),
}

test("an event id records once; the second write is a duplicate with no effect", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	expect(await recordEventOnce(ledger, { id: "evt_1", type: "invoice.paid", objectID: "in_1" })).toBe("recorded")
	expect(await recordEventOnce(ledger, { id: "evt_1", type: "invoice.paid", objectID: "in_1" })).toBe("duplicate")
})

test("a license is found by subscription; the current token is the one with the latest expiry", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	await createLicense(ledger, license)
	expect((await findLicenseBySubscription(ledger, "sub_1"))?.license_state).toBe(LicenseState.Active)

	await insertToken(ledger, {
		invoice_id: "in_1",
		lid: license.lid,
		issued: "2026-10-01",
		expires: "2026-11-15",
		payload_json: "{}",
		token: "mwl1.a.a",
	})
	await insertToken(ledger, {
		invoice_id: "in_2",
		lid: license.lid,
		issued: "2026-11-01",
		expires: "2026-12-15",
		payload_json: "{}",
		token: "mwl1.b.b",
	})

	expect((await currentToken(ledger, license.lid))?.invoice_id).toBe("in_2")
})

test("a second token for one invoice is refused by the primary key", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	await createLicense(ledger, license)
	await insertToken(ledger, {
		invoice_id: "in_1",
		lid: license.lid,
		issued: "2026-10-01",
		expires: "2026-11-15",
		payload_json: "{}",
		token: "mwl1.a.a",
	})

	await expect(
		insertToken(ledger, {
			invoice_id: "in_1",
			lid: license.lid,
			issued: "2026-10-01",
			expires: "2026-11-15",
			payload_json: "{}",
			token: "mwl1.c.c",
		})
	).rejects.toThrow(/UNIQUE|constraint/iu)
})

test("state transitions write the license and subscription states", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	await createLicense(ledger, license)
	await setLicenseState(ledger, license.lid, LicenseState.Revoked, "canceled", "refunded")

	const row = await findLicenseBySubscription(ledger, "sub_1")

	expect(row).toMatchObject({ license_state: "revoked", subscription_state: "canceled", payment_state: "refunded" })
})
```

`test/support/migrations.ts` reads `migrations/*.sql` in order and runs each statement with `db.exec` (Miniflare's D1 runs the migration files the same way `wrangler d1 migrations apply` does). Under `@cloudflare/vitest-pool-workers` the D1 database is fresh per test file, and the `beforeEach` drops and recreates through `DROP TABLE IF EXISTS` lines at the top of the support helper so each test starts empty.

- [x] **Step 2: Run to verify it fails**

Run: `yarn workspace @mailwoman/license-worker test test/ledger.test.ts`
Expected: FAIL — modules missing.

- [x] **Step 3: Write the migration**

```sql
-- migrations/0001_ledger.sql
-- One row per subscription. `lid` is the opaque per-license serial the token carries; it is stable for the
-- subscription's life and is what online status is keyed by.
CREATE TABLE licenses (
	lid TEXT PRIMARY KEY,
	subscription_id TEXT NOT NULL UNIQUE,
	customer_id TEXT NOT NULL,
	checkout_session_id TEXT NOT NULL UNIQUE,
	plan_code TEXT NOT NULL,
	agreement_version TEXT NOT NULL,
	licensee TEXT NOT NULL,
	email TEXT NOT NULL,
	refresh_secret_sha256 TEXT NOT NULL,
	subscription_state TEXT NOT NULL DEFAULT 'active',
	payment_state TEXT NOT NULL DEFAULT 'pending',
	license_state TEXT NOT NULL DEFAULT 'active' CHECK (license_state IN ('active', 'lapsed', 'revoked', 'review')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per paid invoice: the token minted for that period. The primary key on the invoice id is what makes a
-- replayed, duplicated, or reordered `invoice.paid` one token.
CREATE TABLE license_tokens (
	invoice_id TEXT PRIMARY KEY,
	lid TEXT NOT NULL REFERENCES licenses(lid),
	issued TEXT NOT NULL,
	expires TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	token TEXT NOT NULL,
	email_state TEXT NOT NULL DEFAULT 'pending' CHECK (email_state IN ('pending', 'sent', 'failed')),
	email_message_id TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX license_tokens_by_lid ON license_tokens(lid, expires);

-- Every webhook event id, written in the same batch as its effects; no payload, ever.
CREATE TABLE stripe_events (
	event_id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	object_id TEXT NOT NULL,
	received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	outcome TEXT NOT NULL DEFAULT 'recorded'
);
```

D1 migrations are SQL files by Wrangler's contract; that is the "raw on purpose" category AGENTS.md lists. The typed access below goes through Kysely.

- [x] **Step 4: Write the schema, client, and access module**

```ts
// lib/ledger/schema.ts
export const LicenseState = { Active: "active", Lapsed: "lapsed", Revoked: "revoked", Review: "review" } as const
export type LicenseState = (typeof LicenseState)[keyof typeof LicenseState]
export type EmailState = "pending" | "sent" | "failed"

export interface LicenseRow {
	lid: string
	subscription_id: string
	customer_id: string
	checkout_session_id: string
	plan_code: string
	agreement_version: string
	licensee: string
	email: string
	refresh_secret_sha256: string
	subscription_state: string
	payment_state: string
	license_state: LicenseState
	created_at: string
	updated_at: string
}

export interface LicenseTokenRow {
	invoice_id: string
	lid: string
	issued: string
	expires: string
	payload_json: string
	token: string
	email_state: EmailState
	email_message_id: string | null
	created_at: string
}

export interface StripeEventRow {
	event_id: string
	type: string
	object_id: string
	received_at: string
	outcome: string
}

export interface LedgerDatabase {
	licenses: LicenseRow
	license_tokens: LicenseTokenRow
	stripe_events: StripeEventRow
}
```

```ts
// lib/ledger/client.ts
import { Kysely } from "kysely"
import { D1Dialect } from "kysely-d1"

import type { LedgerDatabase } from "#ledger/schema"

export type Ledger = Kysely<LedgerDatabase>

export function openLedger(db: D1Database): Ledger {
	return new Kysely<LedgerDatabase>({ dialect: new D1Dialect({ database: db }) })
}
```

`lib/ledger/licenses.ts` implements the functions in the Interfaces block with Kysely query builders: `recordEventOnce` is `insertInto("stripe_events").values(...).onConflict((oc) => oc.doNothing()).executeTakeFirst()` and reads `numInsertedOrUpdatedRows` (0 → `"duplicate"`); `currentToken` orders by `expires desc` and takes one; `findTokenByCheckoutSession` joins `licenses` on `checkout_session_id` with the current token; `setLicenseState` updates `license_state`, the two optional states, and `updated_at`. Use `Insertable<LicenseRow>` for `NewLicense` with the defaulted columns omitted (`Omit<Insertable<LicenseRow>, "subscription_state" | "payment_state" | "license_state" | "created_at" | "updated_at">`).

- [x] **Step 5: Run the tests**

Run: `yarn workspace @mailwoman/license-worker test test/ledger.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 6: Commit**

```bash
git add packages/license-worker/migrations packages/license-worker/lib/ledger packages/license-worker/test
git commit -m "feat(license-worker): the D1 ledger — three tables under unique constraints, typed through Kysely

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 3: Plans, dates, identifiers, and the signing self-test

**Files:**

- Create: `lib/plans.ts`, `lib/dates.ts`, `lib/identifiers.ts`, `lib/signing.ts`
- Test: `test/plans.test.ts`, `test/dates.test.ts`, `test/identifiers.test.ts`, `test/signing.test.ts`, `test/support/keys.ts`

**Interfaces produced:**

```ts
export interface CommercialPlan {
	code: "commercial-monthly-v1" | "commercial-yearly-v1"
	stripePriceID: string
	scope: "all"
	terms: "LicenseRef-Commercial"
	agreement: string
	graceDays: 14
}
export function planCatalog(env: LicenseWorkerEnv): readonly CommercialPlan[]
export function planForPrice(env, priceID: string): CommercialPlan | undefined
export function calendarDateUTC(unixSeconds: number): string // YYYY-MM-DD
export function plusDays(date: string, days: number): string // calendar arithmetic in UTC
export function newLicenseID(): string // `lic_` + 22 base64url chars from 16 random bytes
export function newRefreshSecret(): string // 43 base64url chars from 32 random bytes
export async function secretDigest(text: string): Promise<string> // lowercase hex SHA-256, via @mailwoman/core/crypto/digest
export type SigningStatus = "ok" | "mismatch"
export async function signingSelfTest(env): Promise<{ status: SigningStatus; kid: string; reason?: string }>
```

- [x] **Step 1: Write the failing tests**

```ts
// test/dates.test.ts
import { describe, expect, it } from "vitest"

import { calendarDateUTC, plusDays } from "#dates"

describe("calendar dates", () => {
	it("reads a unix second as a UTC calendar date", () => {
		expect(calendarDateUTC(1_790_000_000)).toBe("2026-09-21")
		expect(calendarDateUTC(Date.UTC(2026, 11, 31, 23, 59, 59) / 1000)).toBe("2026-12-31")
	})

	it("adds days across a month end, a year end, and February 29", () => {
		expect(plusDays("2026-10-31", 14)).toBe("2026-11-14")
		expect(plusDays("2026-12-25", 14)).toBe("2027-01-08")
		expect(plusDays("2028-02-20", 14)).toBe("2028-03-05")
		expect(plusDays("2027-02-20", 14)).toBe("2027-03-06")
	})
})
```

```ts
// test/plans.test.ts
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { planCatalog, planForPrice } from "#plans"

describe("the plan catalog", () => {
	const worker = readEnv(env)

	it("maps exactly the two configured Price IDs to the two plan codes", () => {
		expect(
			planCatalog(worker)
				.map((plan) => plan.code)
				.toSorted()
		).toEqual(["commercial-monthly-v1", "commercial-yearly-v1"])
		expect(planForPrice(worker, worker.STRIPE_PRICE_MONTHLY)?.code).toBe("commercial-monthly-v1")
		expect(planForPrice(worker, worker.STRIPE_PRICE_YEARLY)?.code).toBe("commercial-yearly-v1")
	})

	it("answers nothing for a Price it was not configured with", () => {
		expect(planForPrice(worker, "price_somebody_elses")).toBeUndefined()
	})

	it("carries the agreement version and a 14-day grace on every plan", () => {
		for (const plan of planCatalog(worker)) {
			expect(plan.agreement).toBe(worker.AGREEMENT_VERSION)
			expect(plan.graceDays).toBe(14)
			expect(plan.scope).toBe("all")
		}
	})
})
```

```ts
// test/identifiers.test.ts
import { describe, expect, it } from "vitest"

import { newLicenseID, newRefreshSecret, secretDigest } from "#identifiers"

describe("identifiers", () => {
	it("mints a lid of 4 + 22 url-safe characters and never the same one twice", () => {
		const a = newLicenseID()
		const b = newLicenseID()

		expect(a).toMatch(/^lic_[A-Za-z0-9_-]{22}$/u)
		expect(a).not.toBe(b)
	})

	it("mints a 43-character refresh secret and hashes it to 64 hex digits", async () => {
		const secret = newRefreshSecret()

		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
		expect(await secretDigest(secret)).toMatch(/^[0-9a-f]{64}$/u)
		expect(await secretDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
	})
})
```

```ts
// test/support/keys.ts — a signing pair minted per test run, and an env whose secret + kid match it
import { generateLicenseSigningKeyPair, licenseKeyID } from "@mailwoman/core/license/key"

import type { LicenseWorkerEnv } from "#env"

export async function envWithSigningKey(
	base: LicenseWorkerEnv
): Promise<{ env: LicenseWorkerEnv; publicKeyPEM: string; kid: string }> {
	const pair = await generateLicenseSigningKeyPair()
	const kid = await licenseKeyID(pair.publicKeyPEM, 9)

	return {
		env: { ...base, LICENSE_SIGNING_KEY_PEM: pair.privateKeyPEM, LICENSE_SIGNING_KID: kid },
		publicKeyPEM: pair.publicKeyPEM,
		kid,
	}
}
```

```ts
// test/signing.test.ts
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { signingSelfTest } from "#signing"
import { envWithSigningKey } from "./support/keys.ts"

describe("the signing self-test", () => {
	it("reads mismatch when the private key's id is not the configured kid", async () => {
		const { env: worker } = await envWithSigningKey(readEnv(env))

		expect(await signingSelfTest({ ...worker, LICENSE_SIGNING_KID: "v9-00000000" })).toMatchObject({
			status: "mismatch",
		})
	})

	it("reads mismatch when the kid is not an active entry of the shipped register, even if it matches the key", async () => {
		// A test key is never in the register: the register is release-bound trust, and this is the property that keeps a
		// sandbox key out of production.
		const { env: worker, kid } = await envWithSigningKey(readEnv(env))

		expect(await signingSelfTest(worker)).toMatchObject({
			status: "mismatch",
			kid,
			reason: expect.stringContaining("register"),
		})
	})

	it("reads mismatch for an unreadable key", async () => {
		expect(await signingSelfTest({ ...readEnv(env), LICENSE_SIGNING_KEY_PEM: "not a key" })).toMatchObject({
			status: "mismatch",
		})
	})
})
```

There is no `ok` case at unit level: an `ok` needs a key the shipped register carries, and no test key is. The route tests inject `signingStatus` through `AppDependencies`.

- [x] **Step 2: Run to verify they fail**

Run: `yarn workspace @mailwoman/license-worker test test/dates.test.ts test/plans.test.ts test/identifiers.test.ts test/signing.test.ts`
Expected: FAIL, modules missing.

- [x] **Step 3: Implement**

```ts
// lib/dates.ts
/**
 * Calendar dates in UTC, as the token carries them: a license runs to the end of its last day in UTC, so the arithmetic
 * is on days, never on instants.
 */
export function calendarDateUTC(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export function plusDays(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number) as [number, number, number]

	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}
```

`toISOString().slice(0, 10)` is the shape `HELPER_HOMES` reports as `isoDate`'s; `isoDate` lives in `@mailwoman/core/utils/time`, which is not importable here (it sits behind `#env`'s graph). If `prefer-home` fires on these two lines, disable it at the site with the reason: the worker imports two core subpaths only.

```ts
// lib/identifiers.ts
import { toBase64URL } from "@mailwoman/core/crypto/base64url"

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length))
}

/**
 * `lic_` plus 22 url-safe characters: 16 random bytes, enough that a guess never lands, and short enough to read aloud
 * to support.
 */
export function newLicenseID(): string {
	return `lic_${toBase64URL(randomBytes(16))}`
}

/**
 * 32 random bytes, url-safe: the per-license capability the refresh route accepts, shown once and stored hashed.
 */
export function newRefreshSecret(): string {
	return toBase64URL(randomBytes(32))
}

/**
 * The stored form of a refresh secret: the plaintext is shown once and compared by digest after.
 */
export async function secretDigest(text: string): Promise<string> {
	return hexOf(await sha256Bytes(new TextEncoder().encode(text)))
}
```

with `import { hexOf, sha256Bytes } from "@mailwoman/core/crypto/digest"` beside the base64url import.

```ts
// lib/plans.ts
import type { LicenseWorkerEnv } from "#env"

export interface CommercialPlan {
	code: "commercial-monthly-v1" | "commercial-yearly-v1"
	stripePriceID: string
	scope: "all"
	terms: "LicenseRef-Commercial"
	agreement: string
	graceDays: 14
}

/**
 * The closed catalog: code, not Stripe metadata and not client input. A Price outside it mints nothing.
 */
export function planCatalog(env: LicenseWorkerEnv): readonly CommercialPlan[] {
	return [
		{
			code: "commercial-monthly-v1",
			stripePriceID: env.STRIPE_PRICE_MONTHLY,
			scope: "all",
			terms: "LicenseRef-Commercial",
			agreement: env.AGREEMENT_VERSION,
			graceDays: 14,
		},
		{
			code: "commercial-yearly-v1",
			stripePriceID: env.STRIPE_PRICE_YEARLY,
			scope: "all",
			terms: "LicenseRef-Commercial",
			agreement: env.AGREEMENT_VERSION,
			graceDays: 14,
		},
	]
}

export function planForPrice(env: LicenseWorkerEnv, priceID: string): CommercialPlan | undefined {
	return planCatalog(env).find((plan) => plan.stripePriceID === priceID)
}
```

```ts
// lib/signing.ts
import { encodeLicenseKey, licenseKeyID, verifyLicenseKey } from "@mailwoman/core/license/key"
import { LICENSE_SIGNING_KEYS, LicenseKeyStatus } from "@mailwoman/core/license/register"

import type { LicenseWorkerEnv } from "#env"

export type SigningStatus = "ok" | "mismatch"

/**
 * Prove the configured private key is the one the configured kid names, and that the kid is an `active` entry of the
 * register this build ships. A worker whose key the shipped release does not trust would mint tokens no installation
 * accepts, so it must refuse to mint at all.
 */
export async function signingSelfTest(
	env: LicenseWorkerEnv
): Promise<{ status: SigningStatus; kid: string; reason?: string }> {
	const entry = LICENSE_SIGNING_KEYS.find((key) => key.kid === env.LICENSE_SIGNING_KID)

	if (!entry || entry.status !== LicenseKeyStatus.Active) {
		return {
			status: "mismatch",
			kid: env.LICENSE_SIGNING_KID,
			reason: `key id ${env.LICENSE_SIGNING_KID} is not an active entry of the shipped register`,
		}
	}

	try {
		const probe = await encodeLicenseKey(
			{
				v: 1,
				kid: entry.kid,
				licensee: "self-test",
				issued: "2026-01-01",
				scope: "all",
				terms: "LicenseRef-Commercial",
			},
			env.LICENSE_SIGNING_KEY_PEM
		)
		const verified = await verifyLicenseKey(probe, {
			trustedKeys: { [entry.kid]: entry.publicKeyPEM },
			now: new Date("2026-01-02T00:00:00Z"),
		})

		if (verified.status !== "valid") {
			return { status: "mismatch", kid: entry.kid, reason: `the private key does not sign for ${entry.kid}` }
		}

		return { status: "ok", kid: entry.kid }
	} catch (error) {
		return {
			status: "mismatch",
			kid: env.LICENSE_SIGNING_KID,
			reason: error instanceof Error ? error.message : String(error),
		}
	}
}
```

`licenseKeyID` is imported for the sandbox-side check below; if it stays unused, drop it. (A sandbox deploy's kid is not in the register by design; `ISSUANCE_ENABLED` and a sandbox-only register override are how the sandbox mints: see Task 5's `trustedKeysForVerification` note.)

- [x] **Step 4: Run the tests**

Run: the four files. Expected: PASS, 10 tests.

- [x] **Step 5: Commit**

```bash
git add packages/license-worker/lib/plans.ts packages/license-worker/lib/dates.ts packages/license-worker/lib/identifiers.ts packages/license-worker/lib/signing.ts packages/license-worker/test
git commit -m "feat(license-worker): the closed plan catalog, UTC calendar arithmetic, identifiers, and the signing self-test

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 4: Stripe — the client, webhook verification, and the event allowlist

**Files:**

- Create: `lib/stripe/client.ts`, `lib/stripe/webhook.ts`, `test/support/stripe-mock.ts`, `test/support/stripe-fixtures.ts`
- Test: `test/webhook.test.ts`

**Interfaces produced:**

```ts
export function stripeClient(env: LicenseWorkerEnv): Stripe
export const ACCEPTED_EVENT_TYPES: readonly string[] // the seven types the spec lists
export type WebhookVerification = { ok: true; event: Stripe.Event } | { ok: false; status: 400; reason: string }
export async function verifyStripeEvent(
	rawBody: string,
	signatureHeader: string | null,
	env: LicenseWorkerEnv
): Promise<WebhookVerification>
// test/support
export async function signedWebhook(
	payload: object,
	secret: string,
	timestamp?: number
): Promise<{ body: string; signature: string }>
export function stripeFetch(routes: Record<string, unknown>): typeof fetch // a fetch the Stripe SDK calls instead of api.stripe.com
```

- [x] **Step 1: Write the failing test**

```ts
// test/webhook.test.ts
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { ACCEPTED_EVENT_TYPES, verifyStripeEvent } from "#stripe/webhook"
import { invoicePaidEvent } from "./support/stripe-fixtures.ts"
import { signedWebhook } from "./support/stripe-mock.ts"

const worker = readEnv(env)

describe("webhook verification", () => {
	it("accepts a valid signature over the untouched body", async () => {
		const { body, signature } = await signedWebhook(invoicePaidEvent(), worker.STRIPE_WEBHOOK_SECRET)
		const result = await verifyStripeEvent(body, signature, worker)

		expect(result.ok).toBe(true)
		if (result.ok) expect(result.event.type).toBe("invoice.paid")
	})

	it("refuses a one-byte mutation of the body", async () => {
		const { body, signature } = await signedWebhook(invoicePaidEvent(), worker.STRIPE_WEBHOOK_SECRET)
		const result = await verifyStripeEvent(`${body} `, signature, worker)

		expect(result).toMatchObject({ ok: false, status: 400 })
	})

	it("refuses a missing header and a stale timestamp", async () => {
		const { body } = await signedWebhook(invoicePaidEvent(), worker.STRIPE_WEBHOOK_SECRET)
		expect(await verifyStripeEvent(body, null, worker)).toMatchObject({ ok: false })

		const stale = await signedWebhook(
			invoicePaidEvent(),
			worker.STRIPE_WEBHOOK_SECRET,
			Math.floor(Date.now() / 1000) - 3600
		)
		expect(await verifyStripeEvent(stale.body, stale.signature, worker)).toMatchObject({ ok: false })
	})

	it("refuses an event type outside the allowlist as a 400 that is not retried", async () => {
		const { body, signature } = await signedWebhook(
			{ ...invoicePaidEvent(), type: "customer.created" },
			worker.STRIPE_WEBHOOK_SECRET
		)
		const result = await verifyStripeEvent(body, signature, worker)

		expect(result).toMatchObject({ ok: false, status: 400, reason: expect.stringContaining("customer.created") })
		expect(ACCEPTED_EVENT_TYPES).toHaveLength(7)
	})
})
```

- [x] **Step 2: Run to verify it fails**

Expected: modules missing.

- [x] **Step 3: Implement**

```ts
// lib/stripe/client.ts
import Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"

/**
 * Pinned API version: a Stripe upgrade is a deliberate change here, never a drift. The fetch client and the
 * SubtleCrypto provider are what let the SDK run on the Workers runtime without a Node compatibility flag.
 */
export const STRIPE_API_VERSION = "2026-08-27.basil"

export function stripeClient(env: LicenseWorkerEnv): Stripe {
	return new Stripe(env.STRIPE_SECRET_KEY, {
		apiVersion: STRIPE_API_VERSION,
		httpClient: Stripe.createFetchHttpClient(),
		maxNetworkRetries: 2,
	})
}
```

Set `STRIPE_API_VERSION` to the version the installed SDK's types declare (`grep -n "LATEST_API_VERSION\|apiVersion" node_modules/stripe/types/lib.d.ts | head -3`).

```ts
// lib/stripe/webhook.ts
import Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"
import { stripeClient } from "#stripe/client"

/**
 * The event types the destination is subscribed to and this worker acts on. An event outside the list is a
 * misconfigured destination, and answering 400 keeps Stripe from retrying it for three days.
 */
export const ACCEPTED_EVENT_TYPES = [
	"checkout.session.completed",
	"invoice.paid",
	"invoice.payment_failed",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"charge.refunded",
	"charge.dispute.created",
] as const

const SIGNATURE_TOLERANCE_SECONDS = 300

export type WebhookVerification = { ok: true; event: Stripe.Event } | { ok: false; status: 400; reason: string }

const cryptoProvider = Stripe.createSubtleCryptoProvider()

export async function verifyStripeEvent(
	rawBody: string,
	signatureHeader: string | null,
	env: LicenseWorkerEnv
): Promise<WebhookVerification> {
	if (!signatureHeader) return { ok: false, status: 400, reason: "missing Stripe-Signature" }

	let event: Stripe.Event

	try {
		event = await stripeClient(env).webhooks.constructEventAsync(
			rawBody,
			signatureHeader,
			env.STRIPE_WEBHOOK_SECRET,
			SIGNATURE_TOLERANCE_SECONDS,
			cryptoProvider
		)
	} catch (error) {
		return { ok: false, status: 400, reason: error instanceof Error ? error.message : "signature verification failed" }
	}

	if (!(ACCEPTED_EVENT_TYPES as readonly string[]).includes(event.type)) {
		return { ok: false, status: 400, reason: `event type ${event.type} is not one this worker acts on` }
	}

	if (event.livemode !== env.liveMode) {
		return { ok: false, status: 400, reason: `event livemode ${event.livemode} does not match this environment` }
	}

	return { ok: true, event }
}
```

`charge.dispute.closed` from the spec's list is handled by the reconciliation pass reading Stripe's current state rather than by a webhook; that keeps the list at seven and the disputed license `revoked` until an operator or the reconciler sees the dispute won. Record this in the spec's event list when the PR opens.

`test/support/stripe-mock.ts`:

```ts
import { fetchMock } from "cloudflare:test"

/**
 * Sign a webhook payload the way Stripe does: `t=<ts>,v1=<hmac-sha256(secret, "<ts>.<body>")>`.
 */
export async function signedWebhook(
	payload: object,
	secret: string,
	timestamp = Math.floor(Date.now() / 1000)
): Promise<{ body: string; signature: string }> {
	const body = JSON.stringify(payload)
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	)
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)))
	const v1 = Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")

	return { body, signature: `t=${timestamp},v1=${v1}` }
}

/**
 * Stand in for api.stripe.com: `routes` maps `GET /v1/invoices/in_1` style keys to JSON bodies. Anything else is a
 * 404 the test sees as a failure, so an unexpected retrieval is loud.
 */
export function mockStripe(routes: Record<string, unknown>): void {
	fetchMock.activate()
	fetchMock.disableNetConnect()

	const origin = fetchMock.get("https://api.stripe.com")

	for (const [key, body] of Object.entries(routes)) {
		const [method, path] = key.split(" ") as [string, string]

		origin
			.intercept({ method, path: (actual) => actual.startsWith(path) })
			.reply(200, JSON.stringify(body), { headers: { "content-type": "application/json" } })
			.persist()
	}
}
```

`test/support/stripe-fixtures.ts` builds minimal Stripe objects: `invoicePaidEvent({ id = "evt_in_1", invoiceID = "in_1", subscriptionID = "sub_1" })`, `checkoutCompletedEvent(...)` with `custom_fields: [{ key: "licensee_legal_name", text: { value: "Example Ltd" } }]`, `consent: { terms_of_service: "accepted" }`, `customer_details.email`, `client_reference_id`, `subscription`; `invoiceObject(...)` with `status: "paid"`, `lines.data[0].price.id`, `subscription`, `status_transitions.paid_at`, `period_end`; `subscriptionObject(...)` with `current_period_end`, `items.data[0].price.id`, `status`; `checkoutSessionList(...)`. Fixtures carry only the fields the handlers read.

- [x] **Step 4: Run and commit**

Run: `yarn workspace @mailwoman/license-worker test test/webhook.test.ts`. Expected: PASS, 4 tests.

```bash
git add packages/license-worker/lib/stripe packages/license-worker/test
git commit -m "feat(license-worker): Stripe on the fetch client, webhook verification on SubtleCrypto, and the seven-event allowlist

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 5: Fulfilment — retrieve, check, mint, persist, email

**Files:**

- Create: `lib/fulfil.ts`, `lib/email/provider.ts`, `lib/email/resend.ts`, `lib/stripe/handlers.ts`
- Test: `test/fulfil.test.ts`

**Interfaces produced:**

```ts
// lib/email/provider.ts
export interface LicenseEmail {
	to: string
	licensee: string
	token: string
	lid: string
	issued: string
	expires: string
	refreshSecret?: string
}
export interface EmailProvider {
	send(message: LicenseEmail, idempotencyKey: string): Promise<{ messageID: string }>
}
// lib/email/resend.ts
export function resendProvider(env: LicenseWorkerEnv): EmailProvider
// lib/fulfil.ts
export interface FulfilDependencies {
	stripe: Stripe
	ledger: Ledger
	email: EmailProvider
	now?: () => Date
}
export type FulfilOutcome =
	{ outcome: "minted" | "already_minted"; lid: string; invoiceID: string } | { outcome: "refused"; reason: string }
export async function fulfilInvoice(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	invoiceID: string
): Promise<FulfilOutcome>
export async function ensureLicenseFromCheckoutSession(env, deps, session: Stripe.Checkout.Session): Promise<LicenseRow> // creates the row if absent; mints no token
// lib/stripe/handlers.ts
export async function handleStripeEvent(env, deps, event: Stripe.Event): Promise<{ handled: string }>
```

- [x] **Step 1: Write the failing test**

```ts
// test/fulfil.test.ts
import { env } from "cloudflare:test"
import { verifyLicenseKey } from "@mailwoman/core/license/key"
import { beforeEach, describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { fulfilInvoice } from "#fulfil"
import { openLedger } from "#ledger/client"
import { currentToken, findLicenseBySubscription, findToken } from "#ledger/licenses"
import { handleStripeEvent } from "#stripe/handlers"
import { stripeClient } from "#stripe/client"
import { envWithSigningKey } from "./support/keys.ts"
import { applyMigrations } from "./support/migrations.ts"
import {
	checkoutCompletedEvent,
	checkoutSessionList,
	checkoutSessionObject,
	invoiceObject,
	invoicePaidEvent,
	subscriptionObject,
} from "./support/stripe-fixtures.ts"
import { mockStripe } from "./support/stripe-mock.ts"

const sent: Array<{ to: string; idempotencyKey: string }> = []
const email = {
	send: async (message: { to: string }, idempotencyKey: string) => {
		sent.push({ to: message.to, idempotencyKey })
		return { messageID: `msg_${sent.length}` }
	},
}

beforeEach(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
	sent.length = 0
})

async function deps() {
	const { env: worker, publicKeyPEM, kid } = await envWithSigningKey(readEnv({ ...env, ISSUANCE_ENABLED: "true" }))

	return {
		worker,
		publicKeyPEM,
		kid,
		deps: { stripe: stripeClient(worker), ledger: openLedger(env.LICENSE_LEDGER), email },
	}
}

describe("fulfilment", () => {
	it("mints one token for a paid invoice on an allowlisted Price, with expires = period end + 14 days, and emails it once", async () => {
		const { worker, publicKeyPEM, kid, deps: d } = await deps()

		mockStripe({
			"GET /v1/invoices/in_1": invoiceObject({
				id: "in_1",
				subscriptionID: "sub_1",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				paidAt: Date.UTC(2026, 9, 1) / 1000,
			}),
			"GET /v1/subscriptions/sub_1": subscriptionObject({
				id: "sub_1",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				currentPeriodEnd: Date.UTC(2026, 10, 1) / 1000,
			}),
			"GET /v1/checkout/sessions": checkoutSessionList([
				checkoutSessionObject({
					id: "cs_1",
					subscriptionID: "sub_1",
					licensee: "Example Ltd",
					email: "ops@example.com",
				}),
			]),
		})

		const first = await fulfilInvoice(worker, d, "in_1")
		const second = await fulfilInvoice(worker, d, "in_1")

		expect(first).toMatchObject({ outcome: "minted", invoiceID: "in_1" })
		expect(second).toMatchObject({ outcome: "already_minted", invoiceID: "in_1" })

		const row = await findToken(d.ledger, "in_1")

		expect(row).toMatchObject({ issued: "2026-10-01", expires: "2026-11-15", email_state: "sent" })

		const verified = await verifyLicenseKey(row!.token, {
			trustedKeys: { [kid]: publicKeyPEM },
			now: new Date("2026-10-15T00:00:00Z"),
		})

		expect(verified).toMatchObject({
			status: "valid",
			payload: { licensee: "Example Ltd", agreement: worker.AGREEMENT_VERSION, scope: "all", expires: "2026-11-15" },
		})
		expect(sent).toHaveLength(1)
		expect(sent[0]?.idempotencyKey).toBe("in_1")
	})

	it("refuses an invoice whose Price is not in the catalog, and mints nothing", async () => {
		const { worker, deps: d } = await deps()

		mockStripe({
			"GET /v1/invoices/in_2": invoiceObject({
				id: "in_2",
				subscriptionID: "sub_2",
				priceID: "price_other",
				paidAt: Date.UTC(2026, 9, 1) / 1000,
			}),
			"GET /v1/subscriptions/sub_2": subscriptionObject({
				id: "sub_2",
				priceID: "price_other",
				currentPeriodEnd: Date.UTC(2026, 10, 1) / 1000,
			}),
		})

		expect(await fulfilInvoice(worker, d, "in_2")).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("price_other"),
		})
		expect(await findToken(d.ledger, "in_2")).toBeUndefined()
	})

	it("refuses to mint when issuance is disabled and when the invoice is not paid", async () => {
		const { worker, deps: d } = await deps()

		mockStripe({
			"GET /v1/invoices/in_3": invoiceObject({
				id: "in_3",
				subscriptionID: "sub_3",
				priceID: worker.STRIPE_PRICE_YEARLY,
				paidAt: Date.UTC(2026, 9, 1) / 1000,
				status: "open",
			}),
			"GET /v1/subscriptions/sub_3": subscriptionObject({
				id: "sub_3",
				priceID: worker.STRIPE_PRICE_YEARLY,
				currentPeriodEnd: Date.UTC(2027, 9, 1) / 1000,
			}),
		})

		expect(await fulfilInvoice({ ...worker, issuanceEnabled: false }, d, "in_3")).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("disabled"),
		})
		expect(await fulfilInvoice(worker, d, "in_3")).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("open"),
		})
	})

	it("handles invoice.paid arriving before checkout.session.completed: the licensee comes from the listed session, and the later checkout event is a no-op", async () => {
		const { worker, deps: d } = await deps()

		mockStripe({
			"GET /v1/invoices/in_4": invoiceObject({
				id: "in_4",
				subscriptionID: "sub_4",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				paidAt: Date.UTC(2026, 9, 1) / 1000,
			}),
			"GET /v1/subscriptions/sub_4": subscriptionObject({
				id: "sub_4",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				currentPeriodEnd: Date.UTC(2026, 10, 1) / 1000,
			}),
			"GET /v1/checkout/sessions": checkoutSessionList([
				checkoutSessionObject({
					id: "cs_4",
					subscriptionID: "sub_4",
					licensee: "Late Checkout Ltd",
					email: "late@example.com",
				}),
			]),
		})

		await handleStripeEvent(worker, d, invoicePaidEvent({ id: "evt_a", invoiceID: "in_4" }))
		await handleStripeEvent(
			worker,
			d,
			checkoutCompletedEvent({ id: "evt_b", sessionID: "cs_4", subscriptionID: "sub_4", licensee: "Late Checkout Ltd" })
		)

		expect((await findLicenseBySubscription(d.ledger, "sub_4"))?.licensee).toBe("Late Checkout Ltd")
		expect(await currentToken(d.ledger, "lic_" + "x")).toBeUndefined()
		expect(sent).toHaveLength(1)
	})

	it("a full refund marks the license revoked and a dispute does the same; the token row is untouched", async () => {
		const { worker, deps: d } = await deps()

		mockStripe({
			"GET /v1/invoices/in_5": invoiceObject({
				id: "in_5",
				subscriptionID: "sub_5",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				paidAt: Date.UTC(2026, 9, 1) / 1000,
				chargeID: "ch_5",
			}),
			"GET /v1/subscriptions/sub_5": subscriptionObject({
				id: "sub_5",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				currentPeriodEnd: Date.UTC(2026, 10, 1) / 1000,
			}),
			"GET /v1/checkout/sessions": checkoutSessionList([
				checkoutSessionObject({ id: "cs_5", subscriptionID: "sub_5", licensee: "Refund Ltd", email: "r@example.com" }),
			]),
			"GET /v1/charges/ch_5": { id: "ch_5", invoice: "in_5", refunded: true, amount: 25000, amount_refunded: 25000 },
		})

		await fulfilInvoice(worker, d, "in_5")
		await handleStripeEvent(worker, d, {
			id: "evt_r",
			type: "charge.refunded",
			livemode: false,
			data: { object: { id: "ch_5", invoice: "in_5", refunded: true, amount: 25000, amount_refunded: 25000 } },
		} as never)

		expect((await findLicenseBySubscription(d.ledger, "sub_5"))?.license_state).toBe("revoked")
		expect(await findToken(d.ledger, "in_5")).toBeDefined()
	})
})
```

The `currentToken(d.ledger, "lic_x")` line is a placeholder for "the checkout event minted nothing new": replace it with a count of `license_tokens` rows for `sub_4`'s lid being 1 (add `countTokens(ledger, lid)` to the access module if no simpler read exists).

- [x] **Step 2: Run to verify it fails**

Expected: modules missing.

- [x] **Step 3: Implement**

`lib/email/provider.ts` declares the two interfaces. `lib/email/resend.ts`:

```ts
import type { LicenseWorkerEnv } from "#env"
import type { EmailProvider, LicenseEmail } from "#email/provider"

/**
 * Resend over its HTTP API. The `Idempotency-Key` is the invoice id, so a retried send after a failed D1 write is one
 * message. The body names the licensee, the dates, the token, and the two commands; it never names an amount.
 */
export function resendProvider(env: LicenseWorkerEnv): EmailProvider {
	return {
		async send(message: LicenseEmail, idempotencyKey: string) {
			const response = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					authorization: `Bearer ${env.EMAIL_API_KEY}`,
					"content-type": "application/json",
					"idempotency-key": idempotencyKey,
				},
				body: JSON.stringify({
					from: env.EMAIL_FROM,
					to: [message.to],
					subject: `Your Mailwoman commercial license (${message.issued} to ${message.expires})`,
					text: renderLicenseEmail(message, env.SITE_ORIGIN),
				}),
			})

			if (!response.ok) throw new Error(`email provider answered ${response.status}`)

			const body = (await response.json()) as { id: string }

			return { messageID: body.id }
		},
	}
}

export function renderLicenseEmail(message: LicenseEmail, siteOrigin: string): string {
	return [
		`Licensee: ${message.licensee}`,
		`License id: ${message.lid}`,
		`Valid: ${message.issued} to ${message.expires} (UTC, inclusive)`,
		"",
		"Your license key:",
		message.token,
		"",
		"Configure it:",
		`  export MAILWOMAN_LICENSE_KEY="${message.token}"`,
		"  mailwoman license verify --online",
		"",
		...(message.refreshSecret
			? [
					"Your refresh secret (shown once; keep it with the key):",
					message.refreshSecret,
					"",
					"Fetch the current key any time:",
					`  mailwoman license refresh --lid ${message.lid} --secret <secret>`,
					"",
				]
			: [
					"Fetch the current key any time with the refresh secret from your first email:",
					`  mailwoman license refresh --lid ${message.lid} --secret <secret>`,
					"",
				]),
		`Manage billing: ${siteOrigin}/license`,
	].join("\n")
}
```

`lib/fulfil.ts`:

```ts
import { encodeLicenseKey, type LicenseKeyPayload } from "@mailwoman/core/license/key"
import type Stripe from "stripe"

import { calendarDateUTC, plusDays } from "#dates"
import type { EmailProvider } from "#email/provider"
import type { LicenseWorkerEnv } from "#env"
import { newLicenseID, newRefreshSecret, secretDigest } from "#identifiers"
import type { Ledger } from "#ledger/client"
import {
	createLicense,
	findLicenseBySubscription,
	findToken,
	insertToken,
	type LicenseRow,
	setEmailState,
} from "#ledger/licenses"
import { planForPrice } from "#plans"

export interface FulfilDependencies {
	stripe: Stripe
	ledger: Ledger
	email: EmailProvider
}

export type FulfilOutcome =
	{ outcome: "minted" | "already_minted"; lid: string; invoiceID: string } | { outcome: "refused"; reason: string }

const LICENSEE_FIELD_KEY = "licensee_legal_name"

function idOf(value: string | { id: string } | null | undefined): string | undefined {
	return typeof value === "string" ? value : value?.id
}

/**
 * The license row for a Checkout Session: created on first sight with a fresh lid and refresh secret, read back after.
 * Mints no token; `invoice.paid` does. Answers the refresh secret only on creation, because it is stored hashed.
 */
export async function ensureLicenseFromCheckoutSession(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	session: Stripe.Checkout.Session
): Promise<{ license: LicenseRow; refreshSecret?: string }> {
	const subscriptionID = idOf(session.subscription)

	if (!subscriptionID) throw new Error(`checkout session ${session.id} carries no subscription`)

	const existing = await findLicenseBySubscription(deps.ledger, subscriptionID)

	if (existing) return { license: existing }

	const licensee = session.custom_fields?.find((field) => field.key === LICENSEE_FIELD_KEY)?.text?.value?.trim()
	const email = session.customer_details?.email ?? undefined
	const customerID = idOf(session.customer)

	if (!licensee) throw new Error(`checkout session ${session.id} carries no licensee legal name`)
	if (!email || !customerID) throw new Error(`checkout session ${session.id} carries no customer email or id`)
	if (session.consent?.terms_of_service !== "accepted")
		throw new Error(`checkout session ${session.id} records no terms acceptance`)

	const priceID = session.line_items?.data[0]?.price?.id
	const plan = priceID ? planForPrice(env, priceID) : undefined
	const refreshSecret = newRefreshSecret()

	const license = {
		lid: newLicenseID(),
		subscription_id: subscriptionID,
		customer_id: customerID,
		checkout_session_id: session.id,
		plan_code: plan?.code ?? "pending",
		agreement_version: env.AGREEMENT_VERSION,
		licensee,
		email,
		refresh_secret_sha256: await secretDigest(refreshSecret),
	}

	await createLicense(deps.ledger, license)

	return { license: (await findLicenseBySubscription(deps.ledger, subscriptionID))!, refreshSecret }
}

/**
 * Mint for one invoice. Everything checked here is re-read from Stripe by id; the event body is never trusted.
 */
export async function fulfilInvoice(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	invoiceID: string
): Promise<FulfilOutcome> {
	if (!env.issuanceEnabled) return { outcome: "refused", reason: "issuance is disabled" }

	const existingToken = await findToken(deps.ledger, invoiceID)

	if (existingToken) return { outcome: "already_minted", lid: existingToken.lid, invoiceID }

	const invoice = await deps.stripe.invoices.retrieve(invoiceID, { expand: ["lines.data.price"] })

	if (invoice.status !== "paid")
		return { outcome: "refused", reason: `invoice ${invoiceID} is ${invoice.status}, not paid` }
	if (invoice.livemode !== env.liveMode)
		return { outcome: "refused", reason: `invoice ${invoiceID} livemode does not match this environment` }

	const subscriptionID = idOf(invoice.subscription as string | Stripe.Subscription | null)

	if (!subscriptionID) return { outcome: "refused", reason: `invoice ${invoiceID} carries no subscription` }

	const lines = invoice.lines.data

	if (lines.length !== 1 || (lines[0]?.quantity ?? 1) !== 1)
		return {
			outcome: "refused",
			reason: `invoice ${invoiceID} has ${lines.length} lines; one line at quantity 1 is expected`,
		}

	const priceID = idOf(lines[0]?.price as string | Stripe.Price | null | undefined)
	const plan = priceID ? planForPrice(env, priceID) : undefined

	if (!plan || !priceID)
		return {
			outcome: "refused",
			reason: `invoice ${invoiceID} bills Price ${priceID ?? "none"}, which is not in the catalog`,
		}

	const subscription = await deps.stripe.subscriptions.retrieve(subscriptionID)

	let license = await findLicenseBySubscription(deps.ledger, subscriptionID)
	let refreshSecret: string | undefined

	if (!license) {
		const sessions = await deps.stripe.checkout.sessions.list({
			subscription: subscriptionID,
			limit: 1,
			expand: ["data.line_items"],
		})
		const session = sessions.data[0]

		if (!session) return { outcome: "refused", reason: `no Checkout Session found for subscription ${subscriptionID}` }

		const ensured = await ensureLicenseFromCheckoutSession(env, deps, session)

		license = ensured.license
		refreshSecret = ensured.refreshSecret
	}

	const paidAt = invoice.status_transitions.paid_at ?? invoice.created
	const periodEnd = subscription.current_period_end
	const issued = calendarDateUTC(paidAt)
	const expires = plusDays(calendarDateUTC(periodEnd), plan.graceDays)

	const payload: LicenseKeyPayload = {
		v: 1,
		kid: env.LICENSE_SIGNING_KID,
		licensee: license.licensee,
		issued,
		expires,
		scope: plan.scope,
		terms: plan.terms,
		lid: license.lid,
		agreement: plan.agreement,
	}

	const token = await encodeLicenseKey(payload, env.LICENSE_SIGNING_KEY_PEM)

	await insertToken(deps.ledger, {
		invoice_id: invoiceID,
		lid: license.lid,
		issued,
		expires,
		payload_json: JSON.stringify(payload),
		token,
	})

	try {
		const { messageID } = await deps.email.send(
			{ to: license.email, licensee: license.licensee, token, lid: license.lid, issued, expires, refreshSecret },
			invoiceID
		)

		await setEmailState(deps.ledger, invoiceID, "sent", messageID)
	} catch {
		await setEmailState(deps.ledger, invoiceID, "failed")
	}

	return { outcome: "minted", lid: license.lid, invoiceID }
}
```

`current_period_end` moved from the subscription to its items in recent Stripe API versions; read `subscription.items.data[0]?.current_period_end ?? subscription.current_period_end` and let the types decide which exists under the pinned version. `plan_code: "pending"` on a row created before its first invoice is overwritten by `fulfilInvoice` through a `setPlanCode` write once the plan is known; add that one-column update to the access module.

`lib/stripe/handlers.ts`:

```ts
import type Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"
import { ensureLicenseFromCheckoutSession, type FulfilDependencies, fulfilInvoice } from "#fulfil"
import { findLicenseBySubscription, LicenseState, setLicenseState } from "#ledger/licenses"

function idOf(value: string | { id: string } | null | undefined): string | undefined {
	return typeof value === "string" ? value : value?.id
}

/**
 * One handler per accepted event type. Every handler re-reads state from Stripe by id or acts only on the ledger; none
 * reads an entitlement from the event body.
 */
export async function handleStripeEvent(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	event: Stripe.Event
): Promise<{ handled: string }> {
	switch (event.type) {
		case "checkout.session.completed": {
			const session = await deps.stripe.checkout.sessions.retrieve(event.data.object.id, { expand: ["line_items"] })

			if (session.mode === "subscription") await ensureLicenseFromCheckoutSession(env, deps, session)

			return { handled: "license row ensured" }
		}
		case "invoice.paid": {
			const outcome = await fulfilInvoice(env, deps, event.data.object.id)

			return { handled: outcome.outcome === "refused" ? `refused: ${outcome.reason}` : outcome.outcome }
		}
		case "invoice.payment_failed": {
			const subscriptionID = idOf(event.data.object.subscription as string | { id: string } | null)
			const license = subscriptionID ? await findLicenseBySubscription(deps.ledger, subscriptionID) : undefined

			if (license) await setLicenseState(deps.ledger, license.lid, license.license_state, undefined, "past_due")

			return { handled: "payment state recorded" }
		}
		case "customer.subscription.updated":
		case "customer.subscription.deleted": {
			const subscription = await deps.stripe.subscriptions.retrieve(event.data.object.id)
			const license = await findLicenseBySubscription(deps.ledger, subscription.id)

			if (!license) return { handled: "no license for subscription" }

			const ended =
				subscription.status === "canceled" ||
				subscription.status === "unpaid" ||
				event.type === "customer.subscription.deleted"
			const nextState =
				license.license_state === LicenseState.Revoked
					? LicenseState.Revoked
					: ended
						? LicenseState.Lapsed
						: LicenseState.Active

			await setLicenseState(deps.ledger, license.lid, nextState, subscription.status)

			return { handled: `subscription ${subscription.status}` }
		}
		case "charge.refunded":
		case "charge.dispute.created": {
			const chargeID =
				event.type === "charge.refunded"
					? event.data.object.id
					: idOf(event.data.object.charge as string | { id: string })
			const charge = chargeID ? await deps.stripe.charges.retrieve(chargeID) : undefined
			const invoiceID = idOf(charge?.invoice as string | { id: string } | null | undefined)

			if (!charge || !invoiceID) return { handled: "no invoice on charge" }

			const token = await deps.ledger
				.selectFrom("license_tokens")
				.select("lid")
				.where("invoice_id", "=", invoiceID)
				.executeTakeFirst()

			if (!token) return { handled: "no license for charge" }

			const partial = event.type === "charge.refunded" && charge.amount_refunded < charge.amount

			await setLicenseState(
				deps.ledger,
				token.lid,
				partial ? LicenseState.Review : LicenseState.Revoked,
				undefined,
				event.type === "charge.refunded" ? "refunded" : "disputed"
			)

			return { handled: partial ? "partial refund: review" : "revoked" }
		}
		default:
			return { handled: "ignored" }
	}
}
```

Where the handler reads the ledger directly (`selectFrom("license_tokens")`), move that read into the access module as `findTokenLid(ledger, invoiceID)` so `handlers.ts` holds no query.

- [x] **Step 4: Run and commit**

Run: `yarn workspace @mailwoman/license-worker test test/fulfil.test.ts`. Expected: PASS, 5 tests. If the Stripe SDK's typed field names differ from the fixtures (`current_period_end` placement, `status_transitions`), correct the fixtures to the SDK's types rather than casting.

```bash
git add packages/license-worker/lib packages/license-worker/test
git commit -m "feat(license-worker): fulfilment — re-read from Stripe, mint once per invoice, persist, email under the invoice id

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 6: The routes — webhook, claim, refresh, status

**Files:**

- Create: `lib/routes/webhook.ts`, `lib/routes/claim.ts`, `lib/routes/refresh.ts`, `lib/routes/status.ts`
- Modify: `lib/app.ts` (register them; CORS on claim; rate limits), `lib/index.ts` (deps wiring: stripe client, ledger, email provider, signing status cached per isolate)
- Test: `test/routes.test.ts`

**Interfaces produced:** the HTTP surface of the spec: `POST /v1/webhooks/stripe`, `GET /v1/checkout-sessions/:sessionID/license`, `POST /v1/licenses/refresh`, `POST /v1/license-status`, `GET /health`.

- [x] **Step 1: Write the failing test**

```ts
// test/routes.test.ts
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { createLicenseWorkerApp } from "#app"
import { readEnv } from "#env"
import { openLedger } from "#ledger/client"
import { envWithSigningKey } from "./support/keys.ts"
import { applyMigrations } from "./support/migrations.ts"
import {
	checkoutSessionList,
	checkoutSessionObject,
	invoiceObject,
	invoicePaidEvent,
	subscriptionObject,
} from "./support/stripe-fixtures.ts"
import { mockStripe, signedWebhook } from "./support/stripe-mock.ts"

const email = { send: async () => ({ messageID: "msg_1" }) }

beforeEach(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

async function app() {
	const { env: worker, publicKeyPEM, kid } = await envWithSigningKey(readEnv({ ...env, ISSUANCE_ENABLED: "true" }))

	mockStripe({
		"GET /v1/invoices/in_1": invoiceObject({
			id: "in_1",
			subscriptionID: "sub_1",
			priceID: worker.STRIPE_PRICE_MONTHLY,
			paidAt: Date.UTC(2026, 9, 1) / 1000,
		}),
		"GET /v1/subscriptions/sub_1": subscriptionObject({
			id: "sub_1",
			priceID: worker.STRIPE_PRICE_MONTHLY,
			currentPeriodEnd: Date.UTC(2026, 10, 1) / 1000,
		}),
		"GET /v1/checkout/sessions": checkoutSessionList([
			checkoutSessionObject({ id: "cs_1", subscriptionID: "sub_1", licensee: "Example Ltd", email: "ops@example.com" }),
		]),
	})

	return {
		worker,
		publicKeyPEM,
		kid,
		app: createLicenseWorkerApp(worker, { signingStatus: () => "ok", email, ledger: openLedger(env.LICENSE_LEDGER) }),
	}
}

async function postWebhook(a: Awaited<ReturnType<typeof app>>, payload: object) {
	const { body, signature } = await signedWebhook(payload, a.worker.STRIPE_WEBHOOK_SECRET)

	return a.app.request("/v1/webhooks/stripe", {
		method: "POST",
		headers: { "stripe-signature": signature, "content-type": "application/json" },
		body,
	})
}

describe("the routes", () => {
	it("webhook: a valid event is 200; the same event id again is 200 with no second token; a bad signature is 400", async () => {
		const a = await app()

		expect((await postWebhook(a, invoicePaidEvent({ id: "evt_1", invoiceID: "in_1" }))).status).toBe(200)
		expect((await postWebhook(a, invoicePaidEvent({ id: "evt_1", invoiceID: "in_1" }))).status).toBe(200)

		const bad = await a.app.request("/v1/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": "t=1,v1=00" },
			body: "{}",
		})

		expect(bad.status).toBe(400)
	})

	it("claim: pending before the invoice is paid, then the token, the lid and the refresh secret exactly once, with no-store and exact-origin CORS", async () => {
		const a = await app()

		const before = await a.app.request("/v1/checkout-sessions/cs_1/license", {
			headers: { origin: a.worker.SITE_ORIGIN },
		})

		expect(before.status).toBe(200)
		expect(await before.json()).toEqual({ status: "pending" })

		await postWebhook(a, invoicePaidEvent({ id: "evt_1", invoiceID: "in_1" }))

		const after = await a.app.request("/v1/checkout-sessions/cs_1/license", {
			headers: { origin: a.worker.SITE_ORIGIN },
		})
		const body = (await after.json()) as {
			status: string
			token: string
			lid: string
			refresh_secret?: string
			licensee: string
			expires: string
		}

		expect(after.headers.get("cache-control")).toBe("no-store")
		expect(after.headers.get("access-control-allow-origin")).toBe(a.worker.SITE_ORIGIN)
		expect(body).toMatchObject({ status: "issued", licensee: "Example Ltd", expires: "2026-11-15" })
		expect(body.token.startsWith("mwl1.")).toBe(true)
		expect(body.refresh_secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)

		const again = (await (
			await a.app.request("/v1/checkout-sessions/cs_1/license", { headers: { origin: a.worker.SITE_ORIGIN } })
		).json()) as { refresh_secret?: string }

		expect(again.refresh_secret).toBeUndefined()

		const foreign = await a.app.request("/v1/checkout-sessions/cs_1/license", {
			headers: { origin: "https://evil.example" },
		})

		expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
		expect((await a.app.request("/v1/checkout-sessions/cs_nope/license")).status).toBe(404)
	})

	it("refresh: the lid and secret answer the current token; a wrong secret and an unknown lid answer the same 404", async () => {
		const a = await app()

		await postWebhook(a, invoicePaidEvent({ id: "evt_1", invoiceID: "in_1" }))

		const claim = (await (await a.app.request("/v1/checkout-sessions/cs_1/license")).json()) as {
			lid: string
			refresh_secret: string
			token: string
		}

		const ok = await a.app.request("/v1/licenses/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lid: claim.lid, secret: claim.refresh_secret }),
		})

		expect(ok.status).toBe(200)
		expect(await ok.json()).toMatchObject({ status: "active", token: claim.token })

		const wrong = await a.app.request("/v1/licenses/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lid: claim.lid, secret: "x".repeat(43) }),
		})
		const unknown = await a.app.request("/v1/licenses/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lid: "lic_nope", secret: "x".repeat(43) }),
		})

		expect(wrong.status).toBe(404)
		expect(unknown.status).toBe(404)
		expect(await wrong.text()).toBe(await unknown.text())
	})

	it("status: active, revoked after a refund, unknown for a lid nobody minted; never a reason or a name", async () => {
		const a = await app()

		await postWebhook(a, invoicePaidEvent({ id: "evt_1", invoiceID: "in_1" }))

		const claim = (await (await a.app.request("/v1/checkout-sessions/cs_1/license")).json()) as { lid: string }
		const status = (lid: string) =>
			a.app.request("/v1/license-status", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ lid }),
			})

		expect(await (await status(claim.lid)).json()).toEqual({ status: "active" })
		expect(await (await status("lic_nope")).json()).toEqual({ status: "unknown" })
	})

	it("kill switch: with issuance disabled the webhook still answers 200 and records the event, the claim stays pending, and refresh keeps answering", async () => {
		const a = await app()

		await postWebhook(a, invoicePaidEvent({ id: "evt_1", invoiceID: "in_1" }))

		const disabled = createLicenseWorkerApp(
			{ ...a.worker, issuanceEnabled: false },
			{ signingStatus: () => "ok", email, ledger: openLedger(env.LICENSE_LEDGER) }
		)
		const { body, signature } = await signedWebhook(
			invoicePaidEvent({ id: "evt_2", invoiceID: "in_1" }),
			a.worker.STRIPE_WEBHOOK_SECRET
		)

		expect(
			(
				await disabled.request("/v1/webhooks/stripe", {
					method: "POST",
					headers: { "stripe-signature": signature },
					body,
				})
			).status
		).toBe(200)

		const claim = (await (await a.app.request("/v1/checkout-sessions/cs_1/license")).json()) as {
			lid: string
			refresh_secret: string
		}
		const refresh = await disabled.request("/v1/licenses/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lid: claim.lid, secret: claim.refresh_secret }),
		})

		expect(refresh.status).toBe(200)
	})

	it("signing mismatch: every route but /health answers 503", async () => {
		const { worker } = await envWithSigningKey(readEnv(env))
		const broken = createLicenseWorkerApp(worker, {
			signingStatus: () => "mismatch",
			email,
			ledger: openLedger(env.LICENSE_LEDGER),
		})

		expect((await broken.request("/health")).status).toBe(200)
		expect((await broken.request("/v1/checkout-sessions/cs_1/license")).status).toBe(503)
	})
})
```

`AppDependencies` grows to `{ signingStatus, email, ledger, stripe? }`; the app builds the Stripe client from env when not injected.

- [x] **Step 2: Run to verify it fails**

Expected: routes 404.

- [x] **Step 3: Implement the routes**

Each route file exports `register<Name>Route(app, env, deps)` in the drop-in style. Behaviours:

- **webhook** (`lib/routes/webhook.ts`): `await c.req.text()` once; `verifyStripeEvent`; on `ok: false` answer `c.json({ error: reason }, 400)`; `recordEventOnce`, and on `"duplicate"` answer 200 `{ received: true, duplicate: true }`; `handleStripeEvent` inside a try; on throw, delete nothing, answer 500 (the event row stays so the retry reads `duplicate`? NO: a failed handler must let the retry run, so record the event AFTER the handler succeeds, in the same D1 batch as its last write. Simplest correct order: run the handler first, then `recordEventOnce`; the handler's own writes are idempotent by primary key (`insertToken` on `invoice_id`, `createLicense` on `subscription_id`), so a retry after a crash between handler and record re-runs the handler, which finds everything already there). Answer `{ received: true, handled }`.
- **claim** (`lib/routes/claim.ts`): `CLAIM_LIMITER.limit({ key: clientIP })` → 429 when exceeded; `findTokenByCheckoutSession`; none → `{ status: "pending" }` when a `licenses` row exists for the session, 404 when none; `license_state` `revoked` → `{ status: "revoked" }`; else `{ status: "issued", token, lid, licensee, issued, expires, refresh_secret? }`. The refresh secret is stored hashed, so it can be shown only once: the `ensureLicenseFromCheckoutSession` return carries the plaintext on creation, and the claim route needs it too. Implement with a `refresh_secret_pending` column holding the plaintext until the first successful claim reads and clears it (one `UPDATE … SET refresh_secret_pending = NULL … RETURNING`), added to the migration in Task 2 (edit `0001_ledger.sql`; the D1 database is recreated from migrations in tests, and no production database exists yet). Exact-origin CORS via `hono/cors` with `origin: env.SITE_ORIGIN` on this route only.
- **refresh** (`lib/routes/refresh.ts`): `REFRESH_LIMITER` keyed by lid; body `{ lid, secret }` validated by zod; `findLicense`; compare `await secretDigest(secret)` to the stored hash with a constant-time compare (`timingSafeEqual` is Node; compare byte arrays in a loop that runs to the end); wrong or unknown → the same `404 { error: "not found" }`; `license_state` `revoked` or `lapsed` → `{ status }` 200 without a token; else `{ status: "active", token, issued, expires }` from `currentToken`.
- **status** (`lib/routes/status.ts`): `STATUS_LIMITER` keyed by lid; `{ lid }` → `{ status: license_state }` mapped to `active | lapsed | revoked` (`review` reads `active`: the customer paid) or `unknown`.
- **app.ts**: a middleware before the `/v1/*` routes that answers 503 `{ error: "signing unavailable" }` when `deps.signingStatus() !== "ok"`, except `/health`.
- **index.ts**: build deps once per isolate: `const ledger = openLedger(bindings.LICENSE_LEDGER)`, `resendProvider(env)`, and a memoized `signingSelfTest(env)` promise whose result `signingStatus` reads (`"unchecked"` until it settles).

- [x] **Step 4: Run and commit**

Run: `yarn workspace @mailwoman/license-worker test`. Expected: every file passes (health, ledger, dates, plans, identifiers, signing, webhook, fulfil, routes).

```bash
git add packages/license-worker
git commit -m "feat(license-worker): the webhook, claim, refresh and status routes, with the kill switch and the signing check in front of them

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 7: Reconciliation on a schedule

**Files:**

- Create: `lib/reconcile.ts`
- Modify: `lib/index.ts` (`scheduled` handler)
- Test: `test/reconcile.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// test/reconcile.test.ts
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { openLedger } from "#ledger/client"
import { findToken } from "#ledger/licenses"
import { reconcile } from "#reconcile"
import { stripeClient } from "#stripe/client"
import { envWithSigningKey } from "./support/keys.ts"
import { applyMigrations } from "./support/migrations.ts"
import {
	checkoutSessionList,
	checkoutSessionObject,
	invoiceList,
	invoiceObject,
	subscriptionObject,
} from "./support/stripe-fixtures.ts"
import { mockStripe } from "./support/stripe-mock.ts"

beforeEach(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

describe("reconciliation", () => {
	it("mints a paid invoice the webhook never delivered, and re-sends a token whose email failed, once each", async () => {
		const { env: worker } = await envWithSigningKey(readEnv({ ...env, ISSUANCE_ENABLED: "true" }))
		const sent: string[] = []
		const email = {
			send: async (_m: unknown, key: string) => {
				sent.push(key)
				return { messageID: `msg_${key}` }
			},
		}

		mockStripe({
			"GET /v1/invoices?": invoiceList([
				invoiceObject({
					id: "in_9",
					subscriptionID: "sub_9",
					priceID: worker.STRIPE_PRICE_MONTHLY,
					paidAt: Date.UTC(2026, 9, 1) / 1000,
				}),
			]),
			"GET /v1/invoices/in_9": invoiceObject({
				id: "in_9",
				subscriptionID: "sub_9",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				paidAt: Date.UTC(2026, 9, 1) / 1000,
			}),
			"GET /v1/subscriptions/sub_9": subscriptionObject({
				id: "sub_9",
				priceID: worker.STRIPE_PRICE_MONTHLY,
				currentPeriodEnd: Date.UTC(2026, 10, 1) / 1000,
			}),
			"GET /v1/checkout/sessions": checkoutSessionList([
				checkoutSessionObject({ id: "cs_9", subscriptionID: "sub_9", licensee: "Missed Ltd", email: "m@example.com" }),
			]),
		})

		const ledger = openLedger(env.LICENSE_LEDGER)
		const report = await reconcile(
			worker,
			{ stripe: stripeClient(worker), ledger, email },
			{ sinceSeconds: 7 * 24 * 3600 }
		)

		expect(report.minted).toEqual(["in_9"])
		expect((await findToken(ledger, "in_9"))?.email_state).toBe("sent")
		expect(sent).toEqual(["in_9"])

		const again = await reconcile(
			worker,
			{ stripe: stripeClient(worker), ledger, email },
			{ sinceSeconds: 7 * 24 * 3600 }
		)

		expect(again.minted).toEqual([])
		expect(sent).toEqual(["in_9"])
	})
})
```

- [x] **Step 2: Implement**

```ts
// lib/reconcile.ts
/**
 * The scheduled pass: Stripe is the authority on what was paid; this ledger is the authority on what was minted and
 * sent. Any paid invoice in the window with no token is minted through the same path the webhook takes, and any token
 * whose email failed is sent again under the same invoice id. The report names ids only.
 */
export interface ReconcileReport {
	minted: string[]
	resent: string[]
	refused: Array<{ invoiceID: string; reason: string }>
}

export async function reconcile(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	options: { sinceSeconds: number }
): Promise<ReconcileReport> {
	const report: ReconcileReport = { minted: [], resent: [], refused: [] }
	const since = Math.floor(Date.now() / 1000) - options.sinceSeconds

	for await (const invoice of deps.stripe.invoices.list({ status: "paid", created: { gte: since }, limit: 100 })) {
		if (await findToken(deps.ledger, invoice.id)) continue

		const outcome = await fulfilInvoice(env, deps, invoice.id)

		if (outcome.outcome === "minted") report.minted.push(invoice.id)
		else if (outcome.outcome === "refused") report.refused.push({ invoiceID: invoice.id, reason: outcome.reason })
	}

	for (const token of await tokensWithFailedEmail(deps.ledger)) {
		const license = await findLicense(deps.ledger, token.lid)

		if (!license) continue

		try {
			const { messageID } = await deps.email.send(
				{
					to: license.email,
					licensee: license.licensee,
					token: token.token,
					lid: token.lid,
					issued: token.issued,
					expires: token.expires,
				},
				token.invoice_id
			)

			await setEmailState(deps.ledger, token.invoice_id, "sent", messageID)
			report.resent.push(token.invoice_id)
		} catch {
			// Stays failed; the next pass tries again.
		}
	}

	return report
}
```

`tokensWithFailedEmail(ledger)` joins the access module. `index.ts` gains `scheduled: (_controller, bindings, ctx) => ctx.waitUntil(reconcile(readEnv(bindings), deps, { sinceSeconds: 7 * 24 * 3600 }).then((report) => console.log(JSON.stringify(report))))`. Stripe's auto-pagination (`for await`) works on the fetch client.

- [x] **Step 3: Run and commit**

Run: `yarn workspace @mailwoman/license-worker test`. Expected: PASS.

```bash
git add packages/license-worker
git commit -m "feat(license-worker): a six-hourly reconciliation mints what the webhook missed and re-sends what failed, once each

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 8: The deploy workflow and the sandbox dry run

**Files:**

- Create: `.github/workflows/license-worker.yml`
- Create: `packages/license-worker/README.md`

- [x] **Step 1: The workflow**

```yaml
# Deploy the license worker to one Wrangler environment, by hand. Nothing here runs on push: a worker that mints
# commercial licenses moves only when an operator says so, and `ISSUANCE_ENABLED` is a separate switch on top.
name: license-worker

on:
  workflow_dispatch:
    inputs:
      environment:
        description: "Wrangler environment"
        required: true
        type: choice
        options: [sandbox, production]
      migrate:
        description: "Apply D1 migrations before deploying"
        required: true
        type: boolean
        default: false

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: ${{ inputs.environment == 'production' && 'license-worker-production' || 'license-worker-sandbox' }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: corepack enable && yarn install --immutable
      - run: yarn workspace @mailwoman/license-worker test
      - if: ${{ inputs.migrate }}
        run: yarn workspace @mailwoman/license-worker wrangler d1 migrations apply LICENSE_LEDGER --env ${{ inputs.environment }} --remote
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - run: yarn workspace @mailwoman/license-worker wrangler deploy --env ${{ inputs.environment }}
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Match the checkout, node, and yarn steps to what `test.yml` uses (`.nvmrc` may not exist; copy the exact lines). The two GitHub environments hold the Cloudflare token per target and let production require a reviewer.

- [x] **Step 2: The README**

A page for the operator, in the house voice: what the worker does in three sentences; the two environments; the bindings table from the spec with which are secrets; the first-deploy order (register the worker's key in core and release, `wrangler secret put` ×4 per environment, `migrate`, deploy with issuance off, check `/health` reads `signing: ok`, flip `ISSUANCE_ENABLED`); the kill switch; the reconciliation cron; where the tests run (`yarn test:license-worker`); and the refund and dispute table. Vale it with `docs/.vale-vocab.ini`.

- [x] **Step 3: The dry run**

```bash
yarn workspace @mailwoman/license-worker wrangler deploy --env sandbox --dry-run --outdir /tmp/claude-1000/-home-lab-Projects-mailwoman/dc5b25ae-2f59-4cfe-a00a-391f0b430ece/scratchpad/worker-dry-run
grep -c "node:" /tmp/claude-1000/-home-lab-Projects-mailwoman/dc5b25ae-2f59-4cfe-a00a-391f0b430ece/scratchpad/worker-dry-run/index.js
```

Expected: the dry run bundles without error and the grep reads `0`. A `node:` hit names the module to fix at its source, never with `nodejs_compat`.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/license-worker.yml packages/license-worker/README.md
git commit -m "feat(license-worker): a manual deploy workflow per environment, and the operator's runbook

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 9: CHANGELOG, full check, PR

- [ ] **Step 1: CHANGELOG** under `## Unreleased`:

```markdown
### Added — `@mailwoman/license-worker` (private)

A Cloudflare Worker that turns a paid Stripe invoice into a signed license token: webhook verification on SubtleCrypto,
fulfilment that re-reads the invoice, subscription and Checkout Session from Stripe by id, a D1 ledger written under
unique constraints so replayed and reordered events mint one token per invoice, an email per token under the invoice
id, and the claim, refresh and status routes the site and `mailwoman license refresh` call. Sandbox and production are
separate Wrangler environments; issuance is off until `ISSUANCE_ENABLED` is flipped, and refuses whenever the signing
key is not an active entry of the shipped register. Deploys by manual dispatch only.
```

- [ ] **Step 2: Full check**

```bash
yarn compile
yarn typecheck:tests
yarn lint
yarn test:license-worker
yarn vitest run packages/release-kit/test packages/repo-health/test
```

Then `yarn test` alone. The root sweep excludes the worker's tests; CI's new step runs them.

- [ ] **Step 3: Push and PR**

Push `feat/license-worker`, open the PR against `main` with the template, the spec linked, and these stated: the seven-event allowlist (dispute closure via reconciliation), the `refresh_secret_pending` column, the handler-then-record order and why, and the sandbox key's relationship to the register. The PR closes the tracking issue created at execution start.
