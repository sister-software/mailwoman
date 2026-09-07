/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shop provisioner against a scripted Stripe: an empty account reads as all missing and writes nothing without
 *   `apply`; with it, every object is created with the catalog's values; a second run finds them all and creates
 *   nothing; an object that differs from the catalog is reported, updated, or replaced by what the difference allows.
 */

import { readEnv } from "@mailwoman/license-worker/env"
import { AGREEMENT_VERSION, SHOP_PLANS, WEBHOOK_EVENTS } from "@mailwoman/license-worker/shop/catalog"
import { withShopIDs } from "@mailwoman/license-worker/shop/ids"
import { provisionShop } from "@mailwoman/license-worker/shop/provision"
import { STRIPE_API_VERSION, stripeClient } from "@mailwoman/license-worker/stripe/client"
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

function shopProduct() {
	return {
		id: "prod_1",
		object: "product",
		metadata: { mailwoman_shop: "commercial-license", agreement_version: AGREEMENT_VERSION },
	}
}

/**
 * An account a first run provisioned, as the catalog describes it.
 */
function provisionedAccount(options: { agreementVersion?: string } = {}): Record<string, StripeRoute> {
	return {
		...emptyAccount(),
		"GET /v1/products?": { object: "list", data: [shopProduct()] },
		"GET /v1/prices?": (form) => ({
			object: "list",
			data: [
				{
					id: `price_${form.get("lookup_keys[]")}`,
					object: "price",
					lookup_key: form.get("lookup_keys[]"),
					unit_amount: SHOP_PLANS.find((plan) => plan.code === form.get("lookup_keys[]"))?.unitAmount,
					currency: "usd",
					recurring: { interval: SHOP_PLANS.find((plan) => plan.code === form.get("lookup_keys[]"))?.interval },
				},
			],
		}),
		"GET /v1/payment_links?": {
			object: "list",
			data: SHOP_PLANS.map((plan) => ({
				id: `plink_${plan.code}`,
				object: "payment_link",
				url: `https://buy.stripe.com/test_${plan.code}`,
				metadata: { plan_code: plan.code, agreement_version: options.agreementVersion ?? AGREEMENT_VERSION },
				consent_collection: { terms_of_service: "required" },
				allow_promotion_codes: true,
				payment_method_collection: "if_required",
			})),
		},
		"GET /v1/billing_portal/configurations?": {
			object: "list",
			data: [
				{
					id: "bpc_1",
					object: "billing_portal.configuration",
					business_profile: {
						headline: "Mailwoman commercial license",
						terms_of_service_url: `${SITE}/license/terms/${AGREEMENT_VERSION}`,
					},
					default_return_url: `${SITE}/license`,
					login_page: { enabled: true, url: "https://billing.stripe.com/p/login/test_portal" },
				},
			],
		},
		"GET /v1/webhook_endpoints?": {
			object: "list",
			data: [
				{
					id: "we_1",
					object: "webhook_endpoint",
					url: `${WORKER}/v1/webhooks/stripe`,
					enabled_events: [...WEBHOOK_EVENTS],
					api_version: STRIPE_API_VERSION,
				},
			],
		},
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
		"POST /v1/billing_portal/configurations": (form) => ({
			id: "bpc_1",
			object: "billing_portal.configuration",
			login_page: {
				enabled: form.get("login_page[enabled]") === "true",
				url: form.get("login_page[enabled]") === "true" ? "https://billing.stripe.com/p/login/test_new" : null,
			},
		}),
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

		expect(report.portal).toEqual({
			id: "bpc_1",
			action: "created",
			url: "https://billing.stripe.com/p/login/test_new",
		})

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
			...provisionedAccount(),
			// The yearly link has fallen behind on the two fields an update can change.
			"GET /v1/payment_links?": {
				object: "list",
				data: SHOP_PLANS.map((plan) => ({
					id: `plink_${plan.code}`,
					object: "payment_link",
					url: `https://buy.stripe.com/test_${plan.code}`,
					metadata: { plan_code: plan.code, agreement_version: AGREEMENT_VERSION },
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
		})

		const report = await provisionShop(stripeClient(worker, stripe.fetch), {
			siteOrigin: SITE,
			workerOrigin: WORKER,
			apply: true,
		})

		expect(report.product).toEqual({ id: "prod_1", action: "exists" })

		expect(report.portal).toEqual({
			id: "bpc_1",
			action: "exists",
			url: "https://billing.stripe.com/p/login/test_portal",
		})

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

	it("a Payment Link on an older agreement is drift under a read-only run, and a replacement under apply", async () => {
		const account = provisionedAccount({ agreementVersion: "commercial-2025-01" })
		const readOnly = recordingStripeFetch(account)

		const plan = await provisionShop(stripeClient(worker, readOnly.fetch), { siteOrigin: SITE, apply: false })

		expect(plan.paymentLinks["commercial-monthly-v1"]).toMatchObject({
			id: "plink_commercial-monthly-v1",
			action: "exists",
			drift: [expect.stringContaining("agreement_version is commercial-2025-01")],
		})

		expect(readOnly.calls.every((call) => call.method === "GET")).toBe(true)

		const applying = recordingStripeFetch({
			...account,
			"POST /v1/payment_links": (form) => ({
				id: `plink_new_${form.get("metadata[plan_code]")}`,
				object: "payment_link",
				url: `https://buy.stripe.com/test_new_${form.get("metadata[plan_code]")}`,
				metadata: { plan_code: form.get("metadata[plan_code]") },
				consent_collection: { terms_of_service: "required" },
			}),
			"POST /v1/payment_links/plink_commercial-monthly-v1": (form) => ({
				id: "plink_commercial-monthly-v1",
				object: "payment_link",
				active: form.get("active") !== "false",
			}),
			"POST /v1/payment_links/plink_commercial-yearly-v1": (form) => ({
				id: "plink_commercial-yearly-v1",
				object: "payment_link",
				active: form.get("active") !== "false",
			}),
		})

		const report = await provisionShop(stripeClient(worker, applying.fetch), { siteOrigin: SITE, apply: true })

		expect(report.paymentLinks["commercial-monthly-v1"]).toEqual({
			id: "plink_new_commercial-monthly-v1",
			url: "https://buy.stripe.com/test_new_commercial-monthly-v1",
			action: "replaced",
			consent: true,
			promotionCodes: true,
		})

		const writes = applying.calls.filter((call) => call.method === "POST")

		// The successor is created before the old link is deactivated, so a refusal leaves the old one selling.
		expect(
			writes.map((call) => [call.path, call.form.get("active") ?? call.form.get("metadata[agreement_version]")])
		).toEqual([
			["/v1/payment_links", AGREEMENT_VERSION],
			["/v1/payment_links/plink_commercial-monthly-v1", "false"],
			["/v1/payment_links", AGREEMENT_VERSION],
			["/v1/payment_links/plink_commercial-yearly-v1", "false"],
		])
	})

	it("a webhook destination missing events is updated; an API version it cannot change stays as drift", async () => {
		const stripe = recordingStripeFetch({
			...provisionedAccount(),
			"GET /v1/webhook_endpoints?": {
				object: "list",
				data: [
					{
						id: "we_1",
						object: "webhook_endpoint",
						url: `${WORKER}/v1/webhooks/stripe`,
						enabled_events: ["invoice.paid"],
						api_version: "2020-08-27",
					},
				],
			},
			"POST /v1/webhook_endpoints/we_1": () => ({ id: "we_1", object: "webhook_endpoint" }),
		})

		const report = await provisionShop(stripeClient(worker, stripe.fetch), {
			siteOrigin: SITE,
			workerOrigin: WORKER,
			apply: true,
		})

		expect(report.webhook).toEqual({
			id: "we_1",
			url: `${WORKER}/v1/webhooks/stripe`,
			action: "updated",
			drift: [`api_version is 2020-08-27; the catalog says ${STRIPE_API_VERSION}`],
		})

		const update = stripe.calls.find((call) => call.method === "POST" && call.path === "/v1/webhook_endpoints/we_1")!

		const enabledEvents = [...update.form.entries()]
			.filter(([key]) => /^enabled_events\[\d+\]$/u.test(key))
			.map(([, value]) => value)

		expect(enabledEvents).toEqual([...WEBHOOK_EVENTS])
	})

	it("a portal whose login page is off is drift under a read-only run, and is switched on under apply with its address answered", async () => {
		const account: Record<string, StripeRoute> = {
			...provisionedAccount(),
			"GET /v1/billing_portal/configurations?": {
				object: "list",
				data: [
					{
						id: "bpc_1",
						object: "billing_portal.configuration",
						business_profile: {
							headline: "Mailwoman commercial license",
							terms_of_service_url: `${SITE}/license/terms/${AGREEMENT_VERSION}`,
						},
						default_return_url: `${SITE}/license`,
						login_page: { enabled: false, url: null },
					},
				],
			},
			"POST /v1/billing_portal/configurations/bpc_1": (form) => ({
				id: "bpc_1",
				object: "billing_portal.configuration",
				login_page: {
					enabled: form.get("login_page[enabled]") === "true",
					url: "https://billing.stripe.com/p/login/live_enabled",
				},
			}),
		}

		const readOnly = recordingStripeFetch(account)
		const plan = await provisionShop(stripeClient(worker, readOnly.fetch), { siteOrigin: SITE, apply: false })

		expect(plan.portal).toEqual({
			id: "bpc_1",
			action: "exists",
			drift: ["login_page.enabled is false; the catalog says true"],
		})

		expect(readOnly.calls.every((call) => call.method === "GET")).toBe(true)

		const applying = recordingStripeFetch(account)
		const report = await provisionShop(stripeClient(worker, applying.fetch), { siteOrigin: SITE, apply: true })

		expect(report.portal).toEqual({
			id: "bpc_1",
			action: "updated",
			url: "https://billing.stripe.com/p/login/live_enabled",
		})

		const update = applying.calls.find(
			(call) => call.method === "POST" && call.path === "/v1/billing_portal/configurations/bpc_1"
		)

		expect(update?.form.get("login_page[enabled]")).toBe("true")
	})

	it("finds the Product on a later page of the list", async () => {
		const stripe = recordingStripeFetch({
			...provisionedAccount(),
			"GET /v1/products?": (form) =>
				form.get("starting_after") === "prod_other"
					? { object: "list", has_more: false, data: [shopProduct()] }
					: { object: "list", has_more: true, data: [{ id: "prod_other", object: "product", metadata: {} }] },
		})

		const report = await provisionShop(stripeClient(worker, stripe.fetch), { siteOrigin: SITE, apply: false })

		expect(report.product).toEqual({ id: "prod_1", action: "exists" })
		expect(stripe.calls.filter((call) => call.path === "/v1/products")).toHaveLength(2)
	})
})

describe("the ids record", () => {
	const current = {
		test: {
			prices: { "commercial-monthly-v1": "price_t1", "commercial-yearly-v1": "price_t2" },
			paymentLinks: { "commercial-monthly-v1": "https://t/1", "commercial-yearly-v1": "https://t/2" },
			portalURL: "https://t/portal",
		},
		live: {
			prices: { "commercial-monthly-v1": "price_l1", "commercial-yearly-v1": "price_l2" },
			paymentLinks: { "commercial-monthly-v1": "https://l/1", "commercial-yearly-v1": "https://l/2" },
			portalURL: "https://l/portal",
		},
	}

	it("replaces the ids a run answered for one mode and leaves an absent id and the other mode standing", () => {
		const next = withShopIDs(current, "live", { prices: { "commercial-monthly-v1": "price_l1_new" }, paymentLinks: {} })

		expect(next.live.prices).toEqual({ "commercial-monthly-v1": "price_l1_new", "commercial-yearly-v1": "price_l2" })
		expect(next.live.paymentLinks).toEqual(current.live.paymentLinks)
		expect(next.live.portalURL).toBe("https://l/portal")
		expect(next.test).toEqual(current.test)

		const withPortal = withShopIDs(next, "live", {
			prices: {},
			paymentLinks: {},
			portalURL: "https://billing.stripe.com/p/login/x",
		})

		expect(withPortal.live.portalURL).toBe("https://billing.stripe.com/p/login/x")

		expect(withShopIDs(withPortal, "live", { prices: {}, paymentLinks: {} }).live.portalURL).toBe(
			"https://billing.stripe.com/p/login/x"
		)
	})
})
