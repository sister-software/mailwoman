/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shop provisioner against a scripted Stripe: an empty account reads as all missing and writes nothing without
 *   `apply`; with it, every object is created with the catalog's values; a second run finds them all and creates
 *   nothing. The wrangler rewrite is held to the file's own shape.
 */

import { readEnv } from "@mailwoman/license-worker/env"
import { AGREEMENT_VERSION, SHOP_PLANS, WEBHOOK_EVENTS } from "@mailwoman/license-worker/shop/catalog"
import { provisionShop } from "@mailwoman/license-worker/shop/provision"
import { readEnvironmentVar, withEnvironmentVars } from "@mailwoman/license-worker/shop/wrangler-vars"
import { stripeClient } from "@mailwoman/license-worker/stripe/client"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { recordingStripeFetch, type StripeRoute } from "../support/stripe-mock.ts"

const worker = readEnv(env)
const SITE = "https://mailwoman.ai"
const WORKER = "https://license.mailwoman.ai"

function emptyAccount(): Record<string, StripeRoute> {
	return {
		"GET /v1/products?": { object: "list", data: [] },
		"GET /v1/prices?": { object: "list", data: [] },
		"GET /v1/payment_links?": { object: "list", data: [] },
		"GET /v1/billing_portal/configurations?": { object: "list", data: [] },
		"GET /v1/webhook_endpoints?": { object: "list", data: [] },
	}
}

function creatingAccount(): Record<string, StripeRoute> {
	return {
		...emptyAccount(),
		"POST /v1/products": (form) => ({ id: "prod_1", object: "product", name: form.get("name"), metadata: {} }),
		"POST /v1/prices": (form) => ({
			id: `price_${form.get("lookup_key")}`,
			object: "price",
			lookup_key: form.get("lookup_key"),
			unit_amount: Number(form.get("unit_amount")),
		}),
		"POST /v1/payment_links": (form) => ({
			id: `plink_${form.get("metadata[plan_code]")}`,
			object: "payment_link",
			url: `https://buy.stripe.com/test_${form.get("metadata[plan_code]")}`,
			metadata: { plan_code: form.get("metadata[plan_code]") },
			consent_collection: { terms_of_service: form.get("consent_collection[terms_of_service]") ?? null },
		}),
		"POST /v1/billing_portal/configurations": () => ({ id: "bpc_1", object: "billing_portal.configuration" }),
		"POST /v1/webhook_endpoints": (form) => ({
			id: "we_1",
			object: "webhook_endpoint",
			url: form.get("url"),
			secret: "whsec_answered_once",
		}),
	}
}

describe("the shop provisioner", () => {
	it("reads an empty account as all missing and sends nothing but reads without apply", async () => {
		const stripe = recordingStripeFetch(emptyAccount())

		const report = await provisionShop(stripeClient(worker, stripe.fetch), {
			siteOrigin: SITE,
			workerOrigin: WORKER,
			apply: false,
		})

		expect(report.product.action).toBe("missing")
		expect(Object.values(report.prices).map((price) => price.action)).toEqual(["missing", "missing"])
		expect(Object.values(report.paymentLinks).map((link) => link.action)).toEqual(["missing", "missing"])
		expect(report.portal.action).toBe("missing")
		expect(report.webhook).toEqual({ url: `${WORKER}/v1/webhooks/stripe`, action: "missing" })
		expect(report.terms.url).toBe(`${SITE}/license/terms/${AGREEMENT_VERSION}`)
		expect(stripe.calls.every((call) => call.method === "GET")).toBe(true)
	})

	it("creates every object from the catalog with apply, and answers the webhook secret once", async () => {
		const stripe = recordingStripeFetch(creatingAccount())

		const report = await provisionShop(stripeClient(worker, stripe.fetch), {
			siteOrigin: SITE,
			workerOrigin: WORKER,
			apply: true,
		})

		expect(report.product).toEqual({ id: "prod_1", action: "created" })

		for (const plan of SHOP_PLANS) {
			expect(report.prices[plan.code]).toEqual({ id: `price_${plan.code}`, action: "created" })
			expect(report.paymentLinks[plan.code]).toMatchObject({ action: "created", consent: true })
		}

		expect(report.portal).toEqual({ id: "bpc_1", action: "created" })

		expect(report.webhook).toEqual({
			id: "we_1",
			url: `${WORKER}/v1/webhooks/stripe`,
			action: "created",
			secret: "whsec_answered_once",
		})

		expect(report.terms.consent).toBe(true)

		const priceCalls = stripe.calls.filter((call) => call.method === "POST" && call.path === "/v1/prices")

		expect(
			priceCalls.map((call) => [
				call.form.get("lookup_key"),
				call.form.get("unit_amount"),
				call.form.get("recurring[interval]"),
			])
		).toEqual([
			["commercial-monthly-v1", "25000", "month"],
			["commercial-yearly-v1", "240000", "year"],
		])

		const link = stripe.calls.find((call) => call.method === "POST" && call.path === "/v1/payment_links")!

		expect(link.form.get("after_completion[redirect][url]")).toBe(
			`${SITE}/license/issued?session_id={CHECKOUT_SESSION_ID}`
		)

		expect(link.form.get("custom_fields[0][key]")).toBe("licensee_legal_name")
		expect(link.form.get("metadata[agreement_version]")).toBe(AGREEMENT_VERSION)
		expect(link.form.get("consent_collection[terms_of_service]")).toBe("required")
		expect(link.form.get("allow_promotion_codes")).toBe("true")
		expect(link.form.get("payment_method_collection")).toBe("if_required")

		const webhook = stripe.calls.find((call) => call.method === "POST" && call.path === "/v1/webhook_endpoints")!

		const enabledEvents = [...webhook.form.entries()]
			.filter(([key]) => /^enabled_events\[\d+\]$/u.test(key))
			.map(([, value]) => value)

		expect(enabledEvents).toEqual([...WEBHOOK_EVENTS])
	})

	it("finds everything on a second run and creates nothing", async () => {
		const stripe = recordingStripeFetch({
			...emptyAccount(),
			"GET /v1/products?": {
				object: "list",
				data: [{ id: "prod_1", object: "product", metadata: { mailwoman_shop: "commercial-license" } }],
			},
			"GET /v1/prices?": (form) => ({
				object: "list",
				data: [{ id: `price_${form.get("lookup_keys[]")}`, object: "price", lookup_key: form.get("lookup_keys[]") }],
			}),
			"GET /v1/payment_links?": {
				object: "list",
				data: SHOP_PLANS.map((plan) => ({
					id: `plink_${plan.code}`,
					object: "payment_link",
					url: `https://buy.stripe.com/test_${plan.code}`,
					metadata: { plan_code: plan.code },
					consent_collection: { terms_of_service: "required" },
					allow_promotion_codes: plan.code === "commercial-monthly-v1",
					payment_method_collection: plan.code === "commercial-monthly-v1" ? "if_required" : "always",
				})),
			},
			"POST /v1/payment_links/plink_commercial-yearly-v1": (form) => ({
				id: "plink_commercial-yearly-v1",
				object: "payment_link",
				allow_promotion_codes: form.get("allow_promotion_codes") === "true",
			}),
			"GET /v1/billing_portal/configurations?": {
				object: "list",
				data: [
					{
						id: "bpc_1",
						object: "billing_portal.configuration",
						business_profile: { headline: "Mailwoman commercial license" },
					},
				],
			},
			"GET /v1/webhook_endpoints?": {
				object: "list",
				data: [{ id: "we_1", object: "webhook_endpoint", url: `${WORKER}/v1/webhooks/stripe` }],
			},
		})

		const report = await provisionShop(stripeClient(worker, stripe.fetch), {
			siteOrigin: SITE,
			workerOrigin: WORKER,
			apply: true,
		})

		expect(report.product).toEqual({ id: "prod_1", action: "exists" })
		expect(report.portal).toEqual({ id: "bpc_1", action: "exists" })
		expect(report.webhook).toEqual({ id: "we_1", url: `${WORKER}/v1/webhooks/stripe`, action: "exists" })

		// The one link that lacked promotion codes is the one write of the run.
		expect(report.paymentLinks["commercial-monthly-v1"]).toMatchObject({
			action: "exists",
			consent: true,
			promotionCodes: true,
		})

		expect(report.paymentLinks["commercial-yearly-v1"]).toMatchObject({
			action: "updated",
			consent: true,
			promotionCodes: true,
		})

		const writes = stripe.calls.filter((call) => call.method === "POST")

		expect(
			writes.map((call) => [
				call.path,
				call.form.get("allow_promotion_codes"),
				call.form.get("payment_method_collection"),
			])
		).toEqual([["/v1/payment_links/plink_commercial-yearly-v1", "true", "if_required"]])
	})

	it("leaves a Payment Link uncreated when Stripe refuses consent collection, and says so in the report", async () => {
		const stripe = recordingStripeFetch({
			...creatingAccount(),
			"POST /v1/payment_links": () => ({
				error: { type: "invalid_request_error", message: "You must set a terms of service URL" },
			}),
		})

		const report = await provisionShop(stripeClient(worker, stripe.fetch), { siteOrigin: SITE, apply: true })

		expect(report.terms.consent).toBe(false)

		expect(Object.values(report.paymentLinks)).toEqual([
			{ action: "blocked", consent: false, promotionCodes: false },
			{ action: "blocked", consent: false, promotionCodes: false },
		])

		// One attempt per plan, each with consent required, and no retry without it.
		const attempts = stripe.calls.filter((call) => call.method === "POST" && call.path === "/v1/payment_links")

		expect(attempts.map((call) => call.form.get("consent_collection[terms_of_service]"))).toEqual([
			"required",
			"required",
		])

		// The product and the prices were still created: they carry no consent.
		expect(report.product.action).toBe("created")
	})
})

describe("the wrangler vars rewrite", () => {
	const toml = [
		'name = "mailwoman-license"',
		"",
		"[env.sandbox.vars]",
		'ISSUANCE_ENABLED = "false"',
		'STRIPE_PRICE_MONTHLY = "price_sandbox_monthly"',
		"",
		"[[env.sandbox.d1_databases]]",
		'binding = "LICENSE_LEDGER"',
		"",
	].join("\n")

	it("replaces a var in place and appends a missing one inside the block, leaving the rest byte-identical", () => {
		const next = withEnvironmentVars(toml, "sandbox", {
			STRIPE_PRICE_MONTHLY: "price_1",
			STRIPE_PRICE_YEARLY: "price_2",
		})

		expect(next).toBe(
			[
				'name = "mailwoman-license"',
				"",
				"[env.sandbox.vars]",
				'ISSUANCE_ENABLED = "false"',
				'STRIPE_PRICE_MONTHLY = "price_1"',
				'STRIPE_PRICE_YEARLY = "price_2"',
				"",
				"[[env.sandbox.d1_databases]]",
				'binding = "LICENSE_LEDGER"',
				"",
			].join("\n")
		)

		expect(readEnvironmentVar(next, "sandbox", "STRIPE_PRICE_YEARLY")).toBe("price_2")
		expect(readEnvironmentVar(next, "production", "STRIPE_PRICE_YEARLY")).toBeUndefined()
		expect(() => withEnvironmentVars(toml, "production", { X: "y" })).toThrow(/no \[env\.production\.vars\]/u)
	})
})
