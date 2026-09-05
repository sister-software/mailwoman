/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { verifyLicenseKey } from "@mailwoman/core/license/key"
import { env } from "cloudflare:workers"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { EmailProvider, LicenseEmail } from "#email/provider"
import { readEnv } from "#env"
import { fulfilInvoice } from "#fulfil"
import { openLedger } from "#ledger/client"
import { countTokens, findLicenseBySubscription, findToken, setEmailState } from "#ledger/licenses"
import { stripeClient } from "#stripe/client"
import { handleStripeEvent } from "#stripe/handlers"

import { envWithSigningKey } from "./support/keys.ts"
import { applyMigrations } from "./support/migrations.ts"
import {
	chargeObject,
	chargeRefundedEvent,
	checkoutCompletedEvent,
	checkoutSessionList,
	checkoutSessionObject,
	invoiceObject,
	invoicePaidEvent,
	invoicePaymentList,
	subscriptionDeletedEvent,
	subscriptionObject,
} from "./support/stripe-fixtures.ts"
import { stripeFetch } from "./support/stripe-mock.ts"

const sent: Array<{ message: LicenseEmail; idempotencyKey: string }> = []

const email: EmailProvider = {
	async send(message, idempotencyKey) {
		sent.push({ message, idempotencyKey })

		return { messageID: `msg_${sent.length}` }
	},
}

const OCT_1 = Date.UTC(2026, 9, 1) / 1000
const NOV_1 = Date.UTC(2026, 10, 1) / 1000
const DEC_1 = Date.UTC(2026, 11, 1) / 1000
const OCT_1_NEXT_YEAR = Date.UTC(2027, 9, 1) / 1000

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

beforeEach(() => {
	sent.length = 0
})

async function fixture(
	suffix: string,
	options: {
		issuance?: boolean
		priceID?: string
		status?: "paid" | "open"
		licensee?: string
		subscriptionStatus?: string
		agreementVersion?: string | null
		renewalInvoiceID?: string
	} = {}
) {
	const bindings = {
		...env,
		ISSUANCE_ENABLED: options.issuance === false ? "false" : "true",
	}

	const signing = await envWithSigningKey(readEnv(bindings))
	const worker = signing.env
	const priceID = options.priceID ?? worker.STRIPE_PRICE_MONTHLY
	const periodEnd = priceID === worker.STRIPE_PRICE_YEARLY ? OCT_1_NEXT_YEAR : NOV_1

	const session = checkoutSessionObject({
		id: `cs_${suffix}`,
		subscriptionID: `sub_${suffix}`,
		licensee: options.licensee ?? "Example Ltd",
		email: "ops@example.com",
		priceID,
		agreementVersion: options.agreementVersion,
	})

	const fetchStripe = stripeFetch({
		[`GET /v1/invoices/in_${suffix}`]: invoiceObject({
			id: `in_${suffix}`,
			subscriptionID: `sub_${suffix}`,
			priceID,
			paidAt: OCT_1,
			periodEnd,
			status: options.status,
		}),
		...(options.renewalInvoiceID
			? {
					[`GET /v1/invoices/${options.renewalInvoiceID}`]: invoiceObject({
						id: options.renewalInvoiceID,
						subscriptionID: `sub_${suffix}`,
						priceID,
						paidAt: NOV_1,
						periodEnd: DEC_1,
					}),
				}
			: {}),
		[`GET /v1/subscriptions/sub_${suffix}`]: subscriptionObject({
			id: `sub_${suffix}`,
			priceID,
			currentPeriodEnd: periodEnd,
			status: options.subscriptionStatus,
		}),
		"GET /v1/checkout/sessions?": checkoutSessionList([session]),
		[`GET /v1/checkout/sessions/cs_${suffix}`]: session,
		[`GET /v1/charges/ch_${suffix}`]: chargeObject({
			id: `ch_${suffix}`,
			paymentIntentID: `pi_${suffix}`,
			amount: 25_000,
			refunded: 25_000,
		}),
		[`GET /v1/invoice_payments?`]: invoicePaymentList({ invoiceID: `in_${suffix}`, paymentIntentID: `pi_${suffix}` }),
	})

	return {
		...signing,
		deps: { stripe: stripeClient(worker, fetchStripe), ledger: openLedger(env.LICENSE_LEDGER), email },
	}
}

describe("fulfilment", () => {
	it("mints one token for a paid invoice on an allowlisted Price, with expires = period end + 14 days, and emails it once", async () => {
		const { env: worker, publicKeyPEM, kid, deps } = await fixture("1")

		expect(await fulfilInvoice(worker, deps, "in_1")).toMatchObject({ outcome: "minted", invoiceID: "in_1" })
		expect(await fulfilInvoice(worker, deps, "in_1")).toMatchObject({ outcome: "already_minted", invoiceID: "in_1" })

		const row = await findToken(deps.ledger, "in_1")

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
		expect(sent[0]?.message.refreshSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
	})

	it("refuses an invoice whose Price is not in the catalog, and mints nothing", async () => {
		const { env: worker, deps } = await fixture("2", { priceID: "price_other" })

		expect(await fulfilInvoice(worker, deps, "in_2")).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("price_other"),
		})

		expect(await findToken(deps.ledger, "in_2")).toBeUndefined()
	})

	it("refuses to mint when issuance is disabled and when the invoice is not paid", async () => {
		const disabled = await fixture("3", { issuance: false, status: "open" })

		expect(await fulfilInvoice(disabled.env, disabled.deps, "in_3")).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("disabled"),
		})

		expect(await fulfilInvoice({ ...disabled.env, issuanceEnabled: true }, disabled.deps, "in_3")).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("open"),
		})
	})

	it("handles invoice.paid arriving before checkout.session.completed: the licensee comes from the listed session, and the later checkout event mints nothing more", async () => {
		const { env: worker, deps } = await fixture("4", { licensee: "Late Checkout Ltd" })

		await handleStripeEvent(worker, deps, invoicePaidEvent({ id: "evt_4a", invoiceID: "in_4" }))

		await handleStripeEvent(
			worker,
			deps,
			checkoutCompletedEvent({
				id: "evt_4b",
				sessionID: "cs_4",
				subscriptionID: "sub_4",
				licensee: "Late Checkout Ltd",
			})
		)

		const license = await findLicenseBySubscription(deps.ledger, "sub_4")

		expect(license?.licensee).toBe("Late Checkout Ltd")
		expect(await countTokens(deps.ledger, license!.lid)).toBe(1)
		expect(sent).toHaveLength(1)
	})

	it("a full refund marks the license revoked; the token row is untouched", async () => {
		const { env: worker, deps } = await fixture("5")

		await fulfilInvoice(worker, deps, "in_5")

		await handleStripeEvent(
			worker,
			deps,
			chargeRefundedEvent({
				id: "evt_5r",
				chargeID: "ch_5",
				paymentIntentID: "pi_5",
				amount: 25_000,
				refunded: 25_000,
			})
		)

		expect((await findLicenseBySubscription(deps.ledger, "sub_5"))?.license_state).toBe("revoked")
		expect(await findToken(deps.ledger, "in_5")).toBeDefined()
	})

	it("a retry that finds the token with its email still pending sends it, once, under the invoice id", async () => {
		const { env: worker, deps } = await fixture("6")

		await fulfilInvoice(worker, deps, "in_6")
		await setEmailState(deps.ledger, "in_6", "pending")

		expect(await fulfilInvoice(worker, deps, "in_6")).toMatchObject({ outcome: "already_minted" })
		expect((await findToken(deps.ledger, "in_6"))?.email_state).toBe("sent")
		expect(sent.map((entry) => entry.idempotencyKey)).toEqual(["in_6", "in_6"])
	})

	it("signs the agreement version the Checkout Session carried, on the first token and on a renewal after the environment moved on; a session without one is refused", async () => {
		const { env: worker, deps, kid, publicKeyPEM } = await fixture("7", { renewalInvoiceID: "in_7b" })

		await fulfilInvoice(worker, deps, "in_7")
		await fulfilInvoice({ ...worker, AGREEMENT_VERSION: "commercial-2027-01" }, deps, "in_7b")

		const verify = (token: string, now: string) =>
			verifyLicenseKey(token, { trustedKeys: { [kid]: publicKeyPEM }, now: new Date(now) })

		const first = await verify((await findToken(deps.ledger, "in_7"))!.token, "2026-10-15T00:00:00Z")
		const renewal = await verify((await findToken(deps.ledger, "in_7b"))!.token, "2026-11-15T00:00:00Z")

		expect(first).toMatchObject({ status: "valid", payload: { agreement: "commercial-2026-10" } })

		expect(renewal).toMatchObject({
			status: "valid",
			payload: { agreement: "commercial-2026-10", expires: "2026-12-15" },
		})

		const bare = await fixture("7n", { agreementVersion: null })

		await expect(fulfilInvoice(bare.env, bare.deps, "in_7n")).rejects.toThrow(/agreement_version/u)
		expect(await findToken(bare.deps.ledger, "in_7n")).toBeUndefined()
	})

	it("a subscription that ends keeps the license active until the current token's date passes, then lapses it", async () => {
		const { env: worker, deps } = await fixture("8", { subscriptionStatus: "canceled" })

		await fulfilInvoice(worker, deps, "in_8")

		const during = { ...deps, now: () => Date.UTC(2026, 9, 20) }
		const after = { ...deps, now: () => Date.UTC(2026, 10, 20) }

		await handleStripeEvent(worker, during, subscriptionDeletedEvent({ id: "evt_8d", subscriptionID: "sub_8" }))

		expect(await findLicenseBySubscription(deps.ledger, "sub_8")).toMatchObject({
			license_state: "active",
			subscription_state: "canceled",
		})

		await handleStripeEvent(worker, after, subscriptionDeletedEvent({ id: "evt_8e", subscriptionID: "sub_8" }))

		expect((await findLicenseBySubscription(deps.ledger, "sub_8"))?.license_state).toBe("lapsed")
	})
})
