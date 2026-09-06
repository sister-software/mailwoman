/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reconcile a Stripe account against the catalog: find each object by the key the catalog gives it, create what is
 *   missing, and report every id. Idempotent by construction, since every lookup is by a key in git (a lookup key, a
 *   metadata mark, a URL) and never by an id. With `apply: false` nothing is written and the report says what would be;
 *   that is the plan an operator reads before the live run. The one value Stripe answers exactly once, the webhook
 *   signing secret, rides in the report and nowhere else.
 */

import type Stripe from "stripe"

import {
	AGREEMENT_METADATA_KEY,
	AGREEMENT_VERSION,
	checkoutCollection,
	SHOP_MARK,
	SHOP_METADATA_KEY,
	SHOP_PLANS,
	SHOP_PRODUCT,
	type ShopPlan,
	shopURLs,
	WEBHOOK_EVENTS,
	WEBHOOK_PATH,
} from "#shop/catalog"
import { STRIPE_API_VERSION } from "#stripe/client"

export interface ProvisionInput {
	/**
	 * The docs site's origin: the success, terms and return URLs derive from it.
	 */
	siteOrigin: string
	/**
	 * The deployed worker's origin; the webhook destination is created only when it is known.
	 */
	workerOrigin?: string
	/**
	 * Write to Stripe. `false` reports what a run would create and creates nothing.
	 */
	apply: boolean
	log?: (line: string) => void
}

/**
 * What the run did to one object: found it, created it, would have created it under `apply`, or could not create it
 * because Stripe refused a required part (a Payment Link's consent collection, until the terms URL is set).
 */
type ProvisionAction = "exists" | "updated" | "created" | "missing" | "blocked"

interface ProvisionedObject {
	id?: string
	action: ProvisionAction
}

export interface ProvisionReport {
	/**
	 * The clickwrap page the Payment Links' consent collection points at. Stripe reads it from the account's public
	 * details, a dashboard setting with no API. A Payment Link is created only with consent collection: the worker
	 * refuses the sessions a link without it produces, so a refusal leaves the link `blocked` rather than half-made.
	 */
	terms: { url: string; consent: boolean }
	product: ProvisionedObject
	prices: Record<ShopPlan["code"], ProvisionedObject>
	paymentLinks: Record<
		ShopPlan["code"],
		ProvisionedObject & { url?: string; consent: boolean; promotionCodes: boolean }
	>
	portal: ProvisionedObject
	webhook?: ProvisionedObject & { url: string; secret?: string }
}

function planRecord<T>(build: (plan: ShopPlan) => T): Record<ShopPlan["code"], T> {
	return Object.fromEntries(SHOP_PLANS.map((plan) => [plan.code, build(plan)])) as Record<ShopPlan["code"], T>
}

export async function provisionShop(stripe: Stripe, input: ProvisionInput): Promise<ProvisionReport> {
	const log = input.log ?? (() => {})
	const urls = shopURLs(input.siteOrigin)

	// Consent collection is required on every link; Stripe refuses it while the account's terms URL is unset, and a
	// refusal blocks that link rather than creating one the worker would refuse sessions from.
	let consent = true

	// The Product.
	const products = await stripe.products.list({ active: true, limit: 100 })
	let product = products.data.find((candidate) => candidate.metadata[SHOP_METADATA_KEY] === SHOP_MARK)
	let productAction: ProvisionAction = product ? "exists" : "missing"

	if (!product && input.apply) {
		product = await stripe.products.create({
			name: SHOP_PRODUCT.name,
			description: SHOP_PRODUCT.description,
			url: urls.licenseURL,
			metadata: { [SHOP_METADATA_KEY]: SHOP_MARK, [AGREEMENT_METADATA_KEY]: AGREEMENT_VERSION },
		})

		productAction = "created"
	}

	// The Prices, by lookup key.
	const prices: ProvisionReport["prices"] = planRecord(() => ({ action: "missing" }))

	for (const plan of SHOP_PLANS) {
		const listed = await stripe.prices.list({ lookup_keys: [plan.code], active: true, limit: 1 })
		let price = listed.data[0]

		if (price) {
			prices[plan.code] = { id: price.id, action: "exists" }

			continue
		}

		if (!input.apply || !product) continue

		price = await stripe.prices.create({
			product: product.id,
			currency: plan.currency,
			unit_amount: plan.unitAmount,
			recurring: { interval: plan.interval },
			lookup_key: plan.code,
			nickname: plan.code,
			metadata: { [SHOP_METADATA_KEY]: SHOP_MARK },
		})

		prices[plan.code] = { id: price.id, action: "created" }
	}

	// The Payment Links, one per plan, marked with the plan code.
	const links = await stripe.paymentLinks.list({ active: true, limit: 100 })

	const paymentLinks: ProvisionReport["paymentLinks"] = planRecord(() => ({
		action: "missing",
		consent: false,
		promotionCodes: false,
	}))

	for (const plan of SHOP_PLANS) {
		const existing = links.data.find((link) => link.metadata.plan_code === plan.code)

		if (existing) {
			const linkConsent = existing.consent_collection?.terms_of_service === "required"
			let promotionCodes = existing.allow_promotion_codes === true
			let action: ProvisionAction = "exists"

			// The one field a link reconciles after creation: everything else in the collection is fixed at creation
			// and a change to it is a new link.
			if (!promotionCodes && input.apply) {
				await stripe.paymentLinks.update(existing.id, { allow_promotion_codes: true })
				promotionCodes = true
				action = "updated"
			}

			consent &&= linkConsent
			paymentLinks[plan.code] = { id: existing.id, url: existing.url, action, consent: linkConsent, promotionCodes }

			continue
		}

		const priceID = prices[plan.code].id

		if (!input.apply || !priceID) continue

		try {
			const created = await stripe.paymentLinks.create({
				line_items: [{ price: priceID, quantity: 1 }],
				after_completion: { type: "redirect", redirect: { url: urls.successURL } },
				...checkoutCollection(plan.code),
			})

			paymentLinks[plan.code] = {
				id: created.id,
				url: created.url,
				action: "created",
				consent: true,
				promotionCodes: true,
			}
		} catch (error) {
			consent = false
			paymentLinks[plan.code] = { action: "blocked", consent: false, promotionCodes: false }
			log(`Payment Link ${plan.code} not created: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	// The Customer Portal configuration: cancel at period end, update the card, switch between the two Prices.
	const configurations = await stripe.billingPortal.configurations.list({ limit: 10 })

	const existingPortal = configurations.data.find(
		(configuration) => configuration.business_profile.headline === SHOP_PRODUCT.name
	)

	let portal: ProvisionedObject = existingPortal ? { id: existingPortal.id, action: "exists" } : { action: "missing" }
	const priceIDs = SHOP_PLANS.map((plan) => prices[plan.code].id).filter((id): id is string => id !== undefined)

	if (!existingPortal && input.apply && product && priceIDs.length === SHOP_PLANS.length) {
		const created = await stripe.billingPortal.configurations.create({
			business_profile: {
				headline: SHOP_PRODUCT.name,
				terms_of_service_url: urls.termsURL,
				privacy_policy_url: urls.licenseURL,
			},
			default_return_url: urls.licenseURL,
			features: {
				customer_update: { enabled: true, allowed_updates: ["email", "address", "name"] },
				invoice_history: { enabled: true },
				payment_method_update: { enabled: true },
				subscription_cancel: { enabled: true, mode: "at_period_end" },
				subscription_update: {
					enabled: true,
					default_allowed_updates: ["price"],
					products: [{ product: product.id, prices: priceIDs }],
				},
			},
		})

		portal = { id: created.id, action: "created" }
	}

	// The webhook destination, once the worker has an origin.
	let webhook: ProvisionReport["webhook"]

	if (input.workerOrigin) {
		const url = `${input.workerOrigin.replace(/\/$/u, "")}${WEBHOOK_PATH}`
		const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })
		const existing = endpoints.data.find((endpoint) => endpoint.url === url)

		if (existing) {
			webhook = { id: existing.id, url, action: "exists" }
		} else if (input.apply) {
			const created = await stripe.webhookEndpoints.create({
				url,
				enabled_events: [...WEBHOOK_EVENTS],
				api_version: STRIPE_API_VERSION,
				description: SHOP_PRODUCT.name,
				metadata: { [SHOP_METADATA_KEY]: SHOP_MARK },
			})

			webhook = { id: created.id, url, action: "created", ...(created.secret ? { secret: created.secret } : {}) }
		} else {
			webhook = { url, action: "missing" }
		}
	}

	return {
		terms: { url: urls.termsURL, consent },
		product: product ? { id: product.id, action: productAction } : { action: productAction },
		prices,
		paymentLinks,
		portal,
		...(webhook ? { webhook } : {}),
	}
}
