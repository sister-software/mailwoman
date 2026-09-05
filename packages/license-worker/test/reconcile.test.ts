/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { fulfilInvoice } from "#fulfil"
import { openLedger } from "#ledger/client"
import { findLicenseBySubscription, findToken, setEmailState } from "#ledger/licenses"
import { reconcile } from "#reconcile"
import { stripeClient } from "#stripe/client"
import { handleStripeEvent } from "#stripe/handlers"

import { envWithSigningKey } from "./support/keys.ts"
import { applyMigrations } from "./support/migrations.ts"
import {
	chargeObject,
	chargeRefundedEvent,
	checkoutSessionList,
	checkoutSessionObject,
	disputeList,
	invoiceList,
	invoiceObject,
	invoicePaymentList,
	subscriptionObject,
} from "./support/stripe-fixtures.ts"
import { stripeFetch } from "./support/stripe-mock.ts"

const OCT_1 = Date.UTC(2026, 9, 1) / 1000
const NOV_1 = Date.UTC(2026, 10, 1) / 1000
const WEEK = 7 * 24 * 3600

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

function recordingEmail() {
	const sent: string[] = []

	return {
		sent,
		provider: {
			send: async (_message: unknown, key: string) => {
				sent.push(key)

				return { messageID: `msg_${key}` }
			},
		},
	}
}

async function fixture(
	suffix: string,
	options: { subscriptionStatus?: string; disputeStatus?: string; listInvoices?: boolean; chargeRefunded?: number } = {}
) {
	const { env: worker } = await envWithSigningKey(readEnv({ ...env, ISSUANCE_ENABLED: "true" }))

	const invoice = invoiceObject({
		id: `in_${suffix}`,
		subscriptionID: `sub_${suffix}`,
		priceID: worker.STRIPE_PRICE_MONTHLY,
		paidAt: OCT_1,
	})

	const stripe = stripeClient(
		worker,
		stripeFetch({
			"GET /v1/invoices?": invoiceList(options.listInvoices === false ? [] : [invoice]),
			[`GET /v1/invoices/in_${suffix}`]: invoice,
			[`GET /v1/subscriptions/sub_${suffix}`]: subscriptionObject({
				id: `sub_${suffix}`,
				priceID: worker.STRIPE_PRICE_MONTHLY,
				currentPeriodEnd: NOV_1,
				status: options.subscriptionStatus,
			}),
			"GET /v1/checkout/sessions?": checkoutSessionList([
				checkoutSessionObject({
					id: `cs_${suffix}`,
					subscriptionID: `sub_${suffix}`,
					licensee: "Missed Ltd",
					email: "m@example.com",
				}),
			]),
			[`GET /v1/charges/ch_${suffix}`]: chargeObject({
				id: `ch_${suffix}`,
				paymentIntentID: `pi_${suffix}`,
				amount: 25_000,
				refunded: options.chargeRefunded ?? 0,
			}),
			"GET /v1/invoice_payments?": invoicePaymentList({ invoiceID: `in_${suffix}`, paymentIntentID: `pi_${suffix}` }),
			"GET /v1/disputes?": disputeList(
				options.disputeStatus
					? [{ id: `dp_${suffix}`, paymentIntentID: `pi_${suffix}`, status: options.disputeStatus }]
					: []
			),
		})
	)

	const ledger = openLedger(env.LICENSE_LEDGER)

	return { worker, stripe, ledger }
}

describe("reconciliation", () => {
	it("mints a paid invoice the webhook never delivered, and re-sends a token whose email failed, once each", async () => {
		const { worker, stripe, ledger } = await fixture("9")
		const email = recordingEmail()
		const deps = { stripe, ledger, email: email.provider }
		const report = await reconcile(worker, deps, { sinceSeconds: WEEK })

		expect(report).toMatchObject({ minted: ["in_9"], resent: [], refused: [], corrected: [] })
		expect((await findToken(ledger, "in_9"))?.email_state).toBe("sent")
		expect(email.sent).toEqual(["in_9"])

		const again = await reconcile(worker, deps, { sinceSeconds: WEEK })

		expect(again.minted).toEqual([])
		expect(email.sent).toEqual(["in_9"])

		await setEmailState(ledger, "in_9", "failed")

		const resent = await reconcile(worker, deps, { sinceSeconds: WEEK })

		expect(resent.resent).toEqual(["in_9"])
		expect(email.sent).toEqual(["in_9", "in_9"])
		expect((await findToken(ledger, "in_9"))?.email_state).toBe("sent")
	})

	it("lapses a license whose subscription Stripe now reads as canceled, and reports the correction by id", async () => {
		const active = await fixture("10")
		const email = recordingEmail()

		await fulfilInvoice(active.worker, { stripe: active.stripe, ledger: active.ledger, email: email.provider }, "in_10")

		const canceled = await fixture("10", { subscriptionStatus: "canceled", listInvoices: false })

		const report = await reconcile(
			canceled.worker,
			{ stripe: canceled.stripe, ledger: canceled.ledger, email: email.provider },
			{ sinceSeconds: WEEK }
		)

		expect(report.corrected).toContainEqual({ lid: expect.any(String), from: "active", to: "lapsed" })
		expect((await findLicenseBySubscription(canceled.ledger, "sub_10"))?.license_state).toBe("lapsed")
	})

	it("a dispute Stripe has ruled won hands a revoked license back to its subscription's state; a refund stays revoked", async () => {
		const disputed = await fixture("11", { disputeStatus: "won", listInvoices: false })
		const email = recordingEmail()
		const deps = { stripe: disputed.stripe, ledger: disputed.ledger, email: email.provider }

		await fulfilInvoice(disputed.worker, deps, "in_11")

		await handleStripeEvent(disputed.worker, deps, {
			id: "evt_11d",
			object: "event",
			type: "charge.dispute.created",
			livemode: false,
			created: OCT_1,
			data: { object: { id: "dp_11", object: "dispute", charge: "ch_11", status: "needs_response" } },
		} as never)

		expect((await findLicenseBySubscription(disputed.ledger, "sub_11"))?.license_state).toBe("revoked")

		const report = await reconcile(disputed.worker, deps, { sinceSeconds: WEEK })

		expect(report.corrected).toContainEqual({ lid: expect.any(String), from: "revoked", to: "active" })
		expect((await findLicenseBySubscription(disputed.ledger, "sub_11"))?.license_state).toBe("active")

		const refunded = await fixture("12", { disputeStatus: "won", listInvoices: false, chargeRefunded: 25_000 })
		const refundedDeps = { stripe: refunded.stripe, ledger: refunded.ledger, email: email.provider }

		await fulfilInvoice(refunded.worker, refundedDeps, "in_12")

		await handleStripeEvent(
			refunded.worker,
			refundedDeps,
			chargeRefundedEvent({
				id: "evt_12r",
				chargeID: "ch_12",
				paymentIntentID: "pi_12",
				amount: 25_000,
				refunded: 25_000,
			}) as never
		)

		const unchanged = await reconcile(refunded.worker, refundedDeps, { sinceSeconds: WEEK })

		expect(unchanged.corrected.filter((entry) => entry.from === "revoked")).toEqual([])
		expect((await findLicenseBySubscription(refunded.ledger, "sub_12"))?.license_state).toBe("revoked")
	})
})
