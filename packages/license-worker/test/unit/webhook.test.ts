/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { ACCEPTED_EVENT_TYPES, verifyStripeEvent } from "#stripe/webhook"
import { invoicePaidEvent } from "#test/support/stripe-fixtures"
import { signedWebhook } from "#test/support/stripe-mock"

const worker = readEnv(env)

describe("webhook verification", () => {
	it("accepts a valid signature over the untouched body", async () => {
		const { body, signature } = await signedWebhook(invoicePaidEvent(), worker.STRIPE_WEBHOOK_SECRET)
		const result = await verifyStripeEvent(body, signature, worker)

		expect(result.ok).toBe(true)

		if (result.ok) {
			expect(result.event.type).toBe("invoice.paid")
		}
	})

	it("refuses a one-byte mutation of the body", async () => {
		const { body, signature } = await signedWebhook(invoicePaidEvent(), worker.STRIPE_WEBHOOK_SECRET)

		expect(await verifyStripeEvent(`${body} `, signature, worker)).toMatchObject({ ok: false, kind: "signature" })
	})

	it("refuses a missing header and a stale timestamp", async () => {
		const { body } = await signedWebhook(invoicePaidEvent(), worker.STRIPE_WEBHOOK_SECRET)

		expect(await verifyStripeEvent(body, null, worker)).toMatchObject({ ok: false, kind: "signature" })

		const stale = await signedWebhook(
			invoicePaidEvent(),
			worker.STRIPE_WEBHOOK_SECRET,
			Math.floor(Date.now() / 1000) - 3600
		)

		expect(await verifyStripeEvent(stale.body, stale.signature, worker)).toMatchObject({ ok: false, kind: "signature" })
	})

	it("ignores, rather than refuses, an event type outside the allowlist and an event from the other Stripe mode", async () => {
		const other = await signedWebhook({ ...invoicePaidEvent(), type: "customer.created" }, worker.STRIPE_WEBHOOK_SECRET)

		expect(await verifyStripeEvent(other.body, other.signature, worker)).toMatchObject({
			ok: false,
			kind: "ignored",
			reason: expect.stringContaining("customer.created"),
		})

		const live = await signedWebhook(invoicePaidEvent({ livemode: true }), worker.STRIPE_WEBHOOK_SECRET)

		expect(await verifyStripeEvent(live.body, live.signature, worker)).toMatchObject({
			ok: false,
			kind: "ignored",
			reason: expect.stringContaining("livemode"),
		})

		expect(ACCEPTED_EVENT_TYPES).toHaveLength(7)
	})
})
