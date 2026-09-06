/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The rehearsal against a scripted Stripe and a scripted worker: the session it builds collects what the Payment Link
 *   collects, and the renewal half waits on the worker for each token, advances the clock between them, and holds the
 *   renewed expiry to the period end plus the grace.
 */

import { readEnv } from "@mailwoman/license-worker/env"
import { AGREEMENT_VERSION, checkoutCollection } from "@mailwoman/license-worker/shop/catalog"
import { advanceRehearsal, startRehearsal } from "@mailwoman/license-worker/shop/rehearse"
import { stripeClient } from "@mailwoman/license-worker/stripe/client"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { recordingStripeFetch, type StripeRoute } from "../support/stripe-mock.ts"

const worker = readEnv(env)
const SITE = "https://mailwoman.ai"
const WORKER = "https://license-sandbox.example"
const DAY = 86_400
const NOW = 1_800_000_000

function startingAccount(): Record<string, StripeRoute> {
	return {
		"GET /v1/prices?": {
			object: "list",
			data: [{ id: "price_monthly", object: "price", lookup_key: "commercial-monthly-v1" }],
		},
		"POST /v1/test_helpers/test_clocks": (form) => ({
			id: "clock_1",
			object: "test_helpers.test_clock",
			frozen_time: Number(form.get("frozen_time")),
			status: "ready",
		}),
		"POST /v1/customers": (form) => ({ id: "cus_1", object: "customer", test_clock: form.get("test_clock") }),
		"POST /v1/checkout/sessions": (form) => ({
			id: "cs_test_1",
			object: "checkout.session",
			url: `https://checkout.stripe.com/c/pay/cs_test_1#${form.get("customer")}`,
		}),
	}
}

describe("the rehearsal purchase", () => {
	it("builds a Checkout Session for a test-clock customer that collects what the Payment Link collects", async () => {
		const stripe = recordingStripeFetch(startingAccount())

		const start = await startRehearsal(stripeClient(worker, stripe.fetch), {
			siteOrigin: SITE,
			plan: "commercial-monthly-v1",
			licensee: "Rehearsal Licensee Ltd",
			email: "rehearsal@example.com",
			now: () => NOW * 1000,
		})

		expect(start).toEqual({
			clock: "clock_1",
			customer: "cus_1",
			session: "cs_test_1",
			url: "https://checkout.stripe.com/c/pay/cs_test_1#cus_1",
		})

		const clock = stripe.calls.find((call) => call.path === "/v1/test_helpers/test_clocks")
		const customer = stripe.calls.find((call) => call.path === "/v1/customers")
		const session = stripe.calls.find((call) => call.path === "/v1/checkout/sessions")

		expect(clock?.form.get("frozen_time")).toBe(String(NOW))
		expect(customer?.form.get("test_clock")).toBe("clock_1")
		expect(customer?.form.get("name")).toBe("Rehearsal Licensee Ltd")

		const collection = checkoutCollection("commercial-monthly-v1")

		expect(Object.fromEntries(session!.form)).toEqual({
			mode: "subscription",
			customer: "cus_1",
			"line_items[0][price]": "price_monthly",
			"line_items[0][quantity]": "1",
			success_url: `${SITE}/license/issued?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${SITE}/license`,
			"custom_fields[0][key]": collection.custom_fields[0]!.key,
			"custom_fields[0][label][type]": "custom",
			"custom_fields[0][label][custom]": collection.custom_fields[0]!.label.custom,
			"custom_fields[0][type]": "text",
			billing_address_collection: "required",
			"consent_collection[terms_of_service]": "required",
			allow_promotion_codes: "true",
			payment_method_collection: "if_required",
			"metadata[mailwoman_shop]": "commercial-license",
			"metadata[plan_code]": "commercial-monthly-v1",
			"metadata[agreement_version]": AGREEMENT_VERSION,
		})
	})

	it("refuses to start without a provisioned Price", async () => {
		const stripe = recordingStripeFetch({ "GET /v1/prices?": { object: "list", data: [] } })

		await expect(
			startRehearsal(stripeClient(worker, stripe.fetch), {
				siteOrigin: SITE,
				plan: "commercial-yearly-v1",
				licensee: "x",
				email: "x@example.com",
			})
		).rejects.toThrow("run shop provision first")
	})

	it("waits for the first token, advances the clock, waits for the renewal, and holds the expiry to the period end plus the grace", async () => {
		let clockReads = 0
		const periodEnd = NOW + 32 * DAY + 5 * DAY

		const stripe = recordingStripeFetch({
			"GET /v1/checkout/sessions/cs_test_1": {
				id: "cs_test_1",
				object: "checkout.session",
				subscription: "sub_1",
				customer: "cus_1",
			},
			"GET /v1/customers/cus_1": { id: "cus_1", object: "customer", test_clock: "clock_1" },
			"GET /v1/test_helpers/test_clocks/clock_1": () => ({
				id: "clock_1",
				object: "test_helpers.test_clock",
				frozen_time: NOW,
				// Ready when first read, advancing once after the advance, then ready again.
				status: clockReads++ === 1 ? "advancing" : "ready",
			}),
			"POST /v1/test_helpers/test_clocks/clock_1/advance": (form) => ({
				id: "clock_1",
				object: "test_helpers.test_clock",
				frozen_time: Number(form.get("frozen_time")),
				status: "advancing",
			}),
			"GET /v1/subscriptions/sub_1": {
				id: "sub_1",
				object: "subscription",
				items: { object: "list", data: [{ id: "si_1", object: "subscription_item", current_period_end: periodEnd }] },
			},
		})

		// The worker as Stripe's delivery reaches it: pending, the first token twice, then the renewal's.
		const claims = [
			{ status: "pending" },
			{ status: "issued", issued: "2026-09-06", expires: "2026-10-20" },
			{ status: "issued", issued: "2026-09-06", expires: "2026-10-20" },
			{ status: "issued", issued: "2027-02-14", expires: "2027-03-07" },
		]

		const asked: string[] = []

		const workerFetch: typeof fetch = async (input) => {
			asked.push(String(input))

			return Response.json(claims[Math.min(asked.length - 1, claims.length - 1)])
		}

		const slept: number[] = []

		const renewal = await advanceRehearsal(stripeClient(worker, stripe.fetch), {
			session: "cs_test_1",
			workerOrigin: WORKER,
			days: 32,
			fetch: workerFetch,
			sleep: async (ms) => {
				slept.push(ms)
			},
			pollMs: 1,
		})

		expect(renewal).toEqual({
			subscription: "sub_1",
			clock: "clock_1",
			first: { issued: "2026-09-06", expires: "2026-10-20" },
			renewed: { issued: "2027-02-14", expires: "2027-03-07" },
			periodEnd: "2027-02-21",
			expected: "2027-03-07",
			agrees: true,
		})

		expect(asked.every((url) => url === `${WORKER}/v1/checkout-sessions/cs_test_1/license`)).toBe(true)
		expect(asked).toHaveLength(4)

		const advance = stripe.calls.find((call) => call.path === "/v1/test_helpers/test_clocks/clock_1/advance")

		expect(advance?.form.get("frozen_time")).toBe(String(NOW + 32 * DAY))
		// One wait on the pending claim, one on the advancing clock, one on the unchanged token.
		expect(slept).toEqual([1, 1, 1])
	})

	it("refuses a customer that is not on a test clock", async () => {
		const stripe = recordingStripeFetch({
			"GET /v1/checkout/sessions/cs_test_2": {
				id: "cs_test_2",
				object: "checkout.session",
				subscription: "sub_2",
				customer: "cus_2",
			},
			"GET /v1/customers/cus_2": { id: "cus_2", object: "customer", test_clock: null },
		})

		await expect(
			advanceRehearsal(stripeClient(worker, stripe.fetch), {
				session: "cs_test_2",
				workerOrigin: WORKER,
				days: 32,
				fetch: async () => Response.json({ status: "pending" }),
				sleep: async () => {},
			})
		).rejects.toThrow("not on a test clock")
	})
})
