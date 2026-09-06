/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createLicenseWorkerApp } from "@mailwoman/license-worker/app"
import { readEnv } from "@mailwoman/license-worker/env"
import { openLedger } from "@mailwoman/license-worker/ledger/client"
import { stripeClient } from "@mailwoman/license-worker/stripe/client"
import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { envWithSigningKey } from "../support/keys.ts"
import { applyMigrations } from "../support/migrations.ts"
import {
	chargeObject,
	chargeRefundedEvent,
	checkoutSessionList,
	checkoutSessionObject,
	invoiceObject,
	invoicePaidEvent,
	invoicePaymentList,
	subscriptionObject,
} from "../support/stripe-fixtures.ts"
import { signedWebhook, stripeFetch } from "../support/stripe-mock.ts"

const email = { send: async () => ({ messageID: "msg_1" }) }

const OCT_1 = Date.UTC(2026, 9, 1) / 1000
const NOV_1 = Date.UTC(2026, 10, 1) / 1000

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

interface ClaimBody {
	status: string
	token: string
	lid: string
	refresh_secret?: string
	licensee: string
	expires: string
}

/**
 * One app per test, over its own suffix, so the tests share one D1 without sharing rows.
 */
async function app(suffix: string, options: { issuance?: boolean; signing?: "ok" | "mismatch" } = {}) {
	const signing = await envWithSigningKey(
		readEnv({ ...env, ISSUANCE_ENABLED: options.issuance === false ? "false" : "true" })
	)

	const worker = signing.env

	const session = checkoutSessionObject({
		id: `cs_${suffix}`,
		subscriptionID: `sub_${suffix}`,
		licensee: "Example Ltd",
		email: "ops@example.com",
		priceID: worker.STRIPE_PRICE_MONTHLY,
	})

	const stripe = stripeClient(
		worker,
		stripeFetch({
			[`GET /v1/invoices/in_${suffix}`]: invoiceObject({
				id: `in_${suffix}`,
				subscriptionID: `sub_${suffix}`,
				priceID: worker.STRIPE_PRICE_MONTHLY,
				paidAt: OCT_1,
				periodEnd: NOV_1,
			}),
			[`GET /v1/subscriptions/sub_${suffix}`]: subscriptionObject({
				id: `sub_${suffix}`,
				priceID: worker.STRIPE_PRICE_MONTHLY,
				currentPeriodEnd: NOV_1,
			}),
			"GET /v1/checkout/sessions?": checkoutSessionList([session]),
			[`GET /v1/checkout/sessions/cs_${suffix}`]: session,
			[`GET /v1/charges/ch_${suffix}`]: chargeObject({
				id: `ch_${suffix}`,
				paymentIntentID: `pi_${suffix}`,
				amount: 25_000,
				refunded: 25_000,
			}),
			"GET /v1/invoice_payments?": invoicePaymentList({ invoiceID: `in_${suffix}`, paymentIntentID: `pi_${suffix}` }),
		})
	)

	const ledger = openLedger(env.LICENSE_LEDGER)

	const hono = createLicenseWorkerApp(worker, {
		signingStatus: () => options.signing ?? "ok",
		email,
		ledger,
		stripe,
	})

	async function webhook(payload: object) {
		const { body, signature } = await signedWebhook(payload, worker.STRIPE_WEBHOOK_SECRET)

		return hono.request("/v1/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": signature, "content-type": "application/json" },
			body,
		})
	}

	function claim(sessionID = `cs_${suffix}`, origin = worker.SITE_ORIGIN) {
		return hono.request(`/v1/checkout-sessions/${sessionID}/license`, { headers: { origin } })
	}

	function post(path: string, body: object) {
		return hono.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
	}

	return { ...signing, worker, hono, stripe, ledger, webhook, claim, post }
}

describe("the routes", () => {
	it("webhook: a valid event is 200; the same event id again is 200 with no second token; a bad signature is 400; a verified stray type is 200 and ignored", async () => {
		const a = await app("w")

		expect((await a.webhook(invoicePaidEvent({ id: "evt_w", invoiceID: "in_w" }))).status).toBe(200)

		const again = await a.webhook(invoicePaidEvent({ id: "evt_w", invoiceID: "in_w" }))

		expect(again.status).toBe(200)
		expect(await again.json()).toEqual({ received: true, duplicate: true })

		const bad = await a.hono.request("/v1/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": "t=1,v1=00" },
			body: "{}",
		})

		expect(bad.status).toBe(400)

		const stray = await a.webhook({ ...invoicePaidEvent({ id: "evt_w_stray" }), type: "customer.created" })

		expect(stray.status).toBe(200)
		expect(await stray.json()).toMatchObject({ received: true, ignored: expect.stringContaining("customer.created") })
	})

	it("claim: pending before the invoice is paid, then the token, the lid and the refresh secret exactly once, with no-store and exact-origin CORS", async () => {
		const a = await app("c")
		const before = await a.claim()

		expect(before.status).toBe(200)
		expect(await before.json()).toEqual({ status: "pending" })

		await a.webhook(invoicePaidEvent({ id: "evt_c", invoiceID: "in_c" }))

		const after = await a.claim()
		const body = (await after.json()) as ClaimBody

		expect(after.headers.get("cache-control")).toBe("no-store")
		expect(after.headers.get("access-control-allow-origin")).toBe(a.worker.SITE_ORIGIN)
		expect(body).toMatchObject({ status: "issued", licensee: "Example Ltd", expires: "2026-11-15" })
		expect(body.token.startsWith("mwl1.")).toBe(true)
		expect(body.refresh_secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)

		const again = (await (await a.claim()).json()) as ClaimBody

		expect(again.refresh_secret).toBeUndefined()
		expect(again.token).toBe(body.token)

		const foreign = await a.claim(`cs_c`, "https://evil.example")

		expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
		expect((await a.claim("cs_nope")).status).toBe(404)
	})

	it("refresh: the lid and secret answer the current token; a wrong secret and an unknown lid answer the same 404", async () => {
		const a = await app("r")

		await a.webhook(invoicePaidEvent({ id: "evt_r", invoiceID: "in_r" }))

		const claim = (await (await a.claim()).json()) as ClaimBody
		const ok = await a.post("/v1/licenses/refresh", { lid: claim.lid, secret: claim.refresh_secret })

		expect(ok.status).toBe(200)
		expect(await ok.json()).toMatchObject({ status: "active", token: claim.token })

		const wrong = await a.post("/v1/licenses/refresh", { lid: claim.lid, secret: "x".repeat(43) })
		const unknown = await a.post("/v1/licenses/refresh", { lid: `lic_${"x".repeat(22)}`, secret: "x".repeat(43) })

		expect(wrong.status).toBe(404)
		expect(unknown.status).toBe(404)
		expect(await wrong.text()).toBe(await unknown.text())
	})

	it("status: active, revoked after a full refund, unknown for a lid nobody minted; never a reason or a name", async () => {
		const a = await app("s")

		await a.webhook(invoicePaidEvent({ id: "evt_s", invoiceID: "in_s" }))

		const claim = (await (await a.claim()).json()) as ClaimBody

		expect(await (await a.post("/v1/license-status", { lid: claim.lid })).json()).toEqual({ status: "active" })

		expect(await (await a.post("/v1/license-status", { lid: `lic_${"x".repeat(22)}` })).json()).toEqual({
			status: "unknown",
		})

		await a.webhook(
			chargeRefundedEvent({
				id: "evt_s_refund",
				chargeID: "ch_s",
				paymentIntentID: "pi_s",
				amount: 25_000,
				refunded: 25_000,
			})
		)

		expect(await (await a.post("/v1/license-status", { lid: claim.lid })).json()).toEqual({ status: "revoked" })
		expect(await (await a.claim()).json()).toEqual({ status: "revoked" })

		expect(
			await (await a.post("/v1/licenses/refresh", { lid: claim.lid, secret: claim.refresh_secret })).json()
		).toEqual({ status: "revoked" })
	})

	it("kill switch: with issuance disabled the webhook still answers 200 and records the event, the claim stays pending, and refresh keeps answering", async () => {
		const a = await app("k")

		await a.webhook(invoicePaidEvent({ id: "evt_k", invoiceID: "in_k" }))

		const claim = (await (await a.claim()).json()) as ClaimBody
		const disabled = await app("k", { issuance: false })
		const later = await disabled.webhook(invoicePaidEvent({ id: "evt_k2", invoiceID: "in_k" }))

		expect(later.status).toBe(200)
		expect(await later.json()).toEqual({ received: true, handled: "refused: issuance is disabled" })

		const refresh = await disabled.post("/v1/licenses/refresh", { lid: claim.lid, secret: claim.refresh_secret })

		expect(refresh.status).toBe(200)

		const fresh = await app("k0", { issuance: false })

		await fresh.webhook(invoicePaidEvent({ id: "evt_k0", invoiceID: "in_k0" }))

		expect(await (await fresh.claim()).json()).toEqual({ status: "pending" })
	})

	it("signing mismatch: every /v1 route answers 503 and /health stays up", async () => {
		const broken = await app("m", { signing: "mismatch" })

		expect((await broken.hono.request("/health")).status).toBe(200)
		expect((await broken.claim()).status).toBe(503)
		expect((await broken.post("/v1/license-status", { lid: `lic_${"x".repeat(22)}` })).status).toBe(503)
		expect((await broken.webhook(invoicePaidEvent({ id: "evt_m", invoiceID: "in_m" }))).status).toBe(503)
	})
})
