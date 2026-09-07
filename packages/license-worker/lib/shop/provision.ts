/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reconcile a Stripe account against the catalog, in three steps per object that the report keeps apart: find it by
 *   the key the catalog gives it (a lookup key, a metadata mark, a URL; never an id, so every page of a list is read
 *   and nothing in git names a Stripe object); compare what Stripe holds with what the catalog says; and, under
 *   `apply`, create what is missing, update what an update can change, and replace what only a new object can carry.
 *   With `apply: false` nothing is written and the report says what would be, differences included; that is the plan
 *   an operator reads before the live run. The one value Stripe answers exactly once, the webhook signing secret, rides
 *   in the report and nowhere else.
 *
 *   What is replaced and what is only reported. A Payment Link whose agreement version or consent collection differs
 *   from the catalog is deactivated and created anew, since neither can change after creation and a link with the old
 *   agreement sells the old terms. A Price's amount and a webhook destination's API version are reported as drift and
 *   left standing: a new Price is a pricing decision, and a new destination is a new signing secret the worker must be
 *   given first. Both are the operator's step.
 */

import type Stripe from "stripe"
import { z } from "zod"

import {
	AGREEMENT_METADATA_KEY,
	AGREEMENT_VERSION,
	checkoutCollection,
	RECONCILED_LINK_FIELDS,
	SHOP_MARK,
	SHOP_METADATA_KEY,
	SHOP_PLAN_CODES,
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
 * What the run did to one object: found it as the catalog describes it, brought it to the catalog by an update,
 * deactivated it and created its successor, created it, would have created it under `apply`, or could not create it
 * because Stripe refused a required part (a Payment Link's consent collection, until the terms URL is set).
 */
const ProvisionActionSchema = z.enum(["exists", "updated", "replaced", "created", "missing", "blocked"])

export type ProvisionAction = z.infer<typeof ProvisionActionSchema>

const ProvisionedObjectSchema = z.object({
	id: z.string().optional(),
	action: ProvisionActionSchema,
	/**
	 * How the object Stripe holds still differs from the catalog after this run: everything found, under a read-only run;
	 * under `apply`, only what no update or replacement here can change.
	 */
	drift: z.array(z.string()).optional(),
})

export type ProvisionedObject = z.infer<typeof ProvisionedObjectSchema>

/**
 * The report's shape, the one definition `mwops shop` validates its output against and this module types its result by.
 */
export const ProvisionReportSchema = z.object({
	/**
	 * The clickwrap page the Payment Links' consent collection points at. Stripe reads it from the account's public
	 * details, a dashboard setting with no API. A Payment Link is created only with consent collection: the worker
	 * refuses the sessions a link without it produces, so a refusal leaves the link `blocked` rather than half-made.
	 */
	terms: z.object({ url: z.string(), consent: z.boolean() }),
	product: ProvisionedObjectSchema,
	prices: z.record(z.enum(SHOP_PLAN_CODES), ProvisionedObjectSchema),
	paymentLinks: z.record(
		z.enum(SHOP_PLAN_CODES),
		ProvisionedObjectSchema.extend({ url: z.string().optional(), consent: z.boolean(), promotionCodes: z.boolean() })
	),
	/**
	 * The portal's login page, once enabled: the address a customer signs in at to change the card, the plan, or cancel.
	 */
	portal: ProvisionedObjectSchema.extend({ url: z.string().optional() }),
	webhook: ProvisionedObjectSchema.extend({ url: z.string(), secret: z.string().optional() }).optional(),
})

export type ProvisionReport = z.infer<typeof ProvisionReportSchema>

function planRecord<T>(build: (plan: ShopPlan) => T): Record<ShopPlan["code"], T> {
	return Object.fromEntries(SHOP_PLANS.map((plan) => [plan.code, build(plan)])) as Record<ShopPlan["code"], T>
}

/**
 * The first listed object that matches, from every page: a match on a later page is not a missing object.
 */
async function findListed<T>(list: AsyncIterable<T>, matches: (item: T) => boolean): Promise<T | undefined> {
	for await (const item of list) {
		if (matches(item)) return item
	}

	return undefined
}

function withDrift<T extends ProvisionedObject>(object: T, drift: string[]): T {
	return drift.length ? { ...object, drift } : object
}

function differs(field: string, held: unknown, wanted: unknown): string[] {
	return held === wanted ? [] : [`${field} is ${String(held)}; the catalog says ${String(wanted)}`]
}

/**
 * Whether two event lists name the same events, in any order.
 */
function sameEvents(held: readonly string[], wanted: readonly string[]): boolean {
	return held.length === wanted.length && wanted.every((event) => held.includes(event))
}

export async function provisionShop(stripe: Stripe, input: ProvisionInput): Promise<ProvisionReport> {
	const log = input.log ?? (() => {})
	const urls = shopURLs(input.siteOrigin)

	// Consent collection is required on every link; Stripe refuses it while the account's terms URL is unset, and a
	// refusal blocks that link rather than creating one the worker would refuse sessions from.
	let consent = true

	// The Product: found by its mark, held to the agreement version it advertises.
	let product = await findListed(
		stripe.products.list({ active: true, limit: 100 }),
		(candidate) => candidate.metadata[SHOP_METADATA_KEY] === SHOP_MARK
	)

	let productReport: ProvisionedObject = product ? { id: product.id, action: "exists" } : { action: "missing" }

	if (product) {
		const drift = differs(AGREEMENT_METADATA_KEY, product.metadata[AGREEMENT_METADATA_KEY], AGREEMENT_VERSION)

		if (drift.length && input.apply) {
			product = await stripe.products.update(product.id, { metadata: { [AGREEMENT_METADATA_KEY]: AGREEMENT_VERSION } })
			productReport = { id: product.id, action: "updated" }
		} else {
			productReport = withDrift(productReport, drift)
		}
	} else if (input.apply) {
		product = await stripe.products.create({
			name: SHOP_PRODUCT.name,
			description: SHOP_PRODUCT.description,
			url: urls.licenseURL,
			metadata: { [SHOP_METADATA_KEY]: SHOP_MARK, [AGREEMENT_METADATA_KEY]: AGREEMENT_VERSION },
		})

		productReport = { id: product.id, action: "created" }
	}

	// The Prices, by lookup key. A Price cannot change, and a new one is a pricing decision, so a difference is reported
	// and left standing.
	const prices: ProvisionReport["prices"] = planRecord(() => ({ action: "missing" }))

	for (const plan of SHOP_PLANS) {
		const listed = await stripe.prices.list({ lookup_keys: [plan.code], active: true, limit: 1 })
		const price = listed.data[0]

		if (price) {
			prices[plan.code] = withDrift({ id: price.id, action: "exists" }, [
				...differs("unit_amount", price.unit_amount, plan.unitAmount),
				...differs("currency", price.currency, plan.currency),
				...differs("recurring.interval", price.recurring?.interval, plan.interval),
			])

			continue
		}

		if (!input.apply || !product) continue

		const created = await stripe.prices.create({
			product: product.id,
			currency: plan.currency,
			unit_amount: plan.unitAmount,
			recurring: { interval: plan.interval },
			lookup_key: plan.code,
			nickname: plan.code,
			metadata: { [SHOP_METADATA_KEY]: SHOP_MARK },
		})

		prices[plan.code] = { id: created.id, action: "created" }
	}

	// The Payment Links, one per plan, marked with the plan code.
	const links: Stripe.PaymentLink[] = []

	for await (const link of stripe.paymentLinks.list({ active: true, limit: 100 })) {
		links.push(link)
	}

	const paymentLinks: ProvisionReport["paymentLinks"] = planRecord(() => ({
		action: "missing",
		consent: false,
		promotionCodes: false,
	}))

	const createLink = async (plan: ShopPlan, priceID: string): Promise<Stripe.PaymentLink> =>
		stripe.paymentLinks.create({
			line_items: [{ price: priceID, quantity: 1 }],
			after_completion: { type: "redirect", redirect: { url: urls.successURL } },
			...checkoutCollection(plan.code),
		})

	for (const plan of SHOP_PLANS) {
		const existing = links.find((link) => link.metadata.plan_code === plan.code)
		const priceID = prices[plan.code].id

		if (existing) {
			const held = {
				id: existing.id,
				url: existing.url,
				consent: existing.consent_collection?.terms_of_service === "required",
				promotionCodes: existing.allow_promotion_codes,
			}

			// Fixed at creation: a difference here is a new link.
			const replacement = [
				...differs(AGREEMENT_METADATA_KEY, existing.metadata[AGREEMENT_METADATA_KEY], AGREEMENT_VERSION),
				...differs("consent_collection.terms_of_service", existing.consent_collection?.terms_of_service, "required"),
			]

			// Changeable in place.
			const update = [
				...differs(
					"allow_promotion_codes",
					existing.allow_promotion_codes,
					RECONCILED_LINK_FIELDS.allow_promotion_codes
				),
				...differs(
					"payment_method_collection",
					existing.payment_method_collection,
					RECONCILED_LINK_FIELDS.payment_method_collection
				),
			]

			if (!input.apply || (!replacement.length && !update.length)) {
				consent &&= held.consent
				paymentLinks[plan.code] = withDrift({ ...held, action: "exists" }, [...replacement, ...update])

				continue
			}

			if (!replacement.length) {
				await stripe.paymentLinks.update(existing.id, RECONCILED_LINK_FIELDS)

				consent &&= held.consent
				paymentLinks[plan.code] = { ...held, action: "updated", promotionCodes: true }

				continue
			}

			if (!priceID) {
				consent &&= held.consent
				paymentLinks[plan.code] = withDrift({ ...held, action: "exists" }, [...replacement, ...update])

				continue
			}

			// The successor is created before the old link is deactivated, so a refusal leaves the old one selling.
			try {
				const created = await createLink(plan, priceID)

				await stripe.paymentLinks.update(existing.id, { active: false })
				log(`Payment Link ${plan.code}: ${existing.id} deactivated for ${created.id} (${replacement.join("; ")})`)

				paymentLinks[plan.code] = {
					id: created.id,
					url: created.url,
					action: "replaced",
					consent: true,
					promotionCodes: true,
				}
			} catch (error) {
				consent = false
				log(`Payment Link ${plan.code} not replaced: ${error instanceof Error ? error.message : String(error)}`)

				paymentLinks[plan.code] = withDrift({ ...held, action: "blocked" }, [...replacement, ...update])
			}

			continue
		}

		if (!input.apply || !priceID) continue

		try {
			const created = await createLink(plan, priceID)

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

	// The Customer Portal configuration: cancel at period end, update the card, switch between the two Prices, and the
	// login page whose address the site and the email hand a customer. Found by its headline, held to the URLs the
	// catalog derives and to the login page being on.
	const existingPortal = await findListed(
		stripe.billingPortal.configurations.list({ limit: 100 }),
		(configuration) => configuration.business_profile.headline === SHOP_PRODUCT.name
	)

	const portalReport = (configuration: Stripe.BillingPortal.Configuration, action: ProvisionAction) => ({
		id: configuration.id,
		action,
		...(configuration.login_page.url ? { url: configuration.login_page.url } : {}),
	})

	let portal: ProvisionReport["portal"] = existingPortal
		? portalReport(existingPortal, "exists")
		: { action: "missing" }

	const priceIDs = SHOP_PLANS.map((plan) => prices[plan.code].id).filter((id): id is string => id !== undefined)

	if (existingPortal) {
		const drift = [
			...differs(
				"business_profile.terms_of_service_url",
				existingPortal.business_profile.terms_of_service_url,
				urls.termsURL
			),
			...differs("default_return_url", existingPortal.default_return_url, urls.licenseURL),
			...differs("login_page.enabled", existingPortal.login_page.enabled, true),
		]

		if (drift.length && input.apply) {
			const updated = await stripe.billingPortal.configurations.update(existingPortal.id, {
				business_profile: { terms_of_service_url: urls.termsURL },
				default_return_url: urls.licenseURL,
				login_page: { enabled: true },
			})

			portal = portalReport(updated, "updated")
		} else {
			portal = withDrift(portal, drift)
		}
	} else if (input.apply && product && priceIDs.length === SHOP_PLANS.length) {
		const created = await stripe.billingPortal.configurations.create({
			business_profile: {
				headline: SHOP_PRODUCT.name,
				terms_of_service_url: urls.termsURL,
				privacy_policy_url: urls.licenseURL,
			},
			default_return_url: urls.licenseURL,
			login_page: { enabled: true },
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

		portal = portalReport(created, "created")
	}

	// The webhook destination, once the worker has an origin: found by URL, held to the event list; its API version
	// cannot change, and a new destination is a new secret, so that difference is reported and left to the operator.
	let webhook: ProvisionReport["webhook"]

	if (input.workerOrigin) {
		const url = `${input.workerOrigin.replace(/\/$/u, "")}${WEBHOOK_PATH}`
		const existing = await findListed(stripe.webhookEndpoints.list({ limit: 100 }), (endpoint) => endpoint.url === url)

		if (existing) {
			const events = sameEvents(existing.enabled_events, WEBHOOK_EVENTS)
				? []
				: [`enabled_events are ${existing.enabled_events.join(", ")}; the catalog says ${WEBHOOK_EVENTS.join(", ")}`]

			const version = differs("api_version", existing.api_version, STRIPE_API_VERSION)

			if (events.length && input.apply) {
				await stripe.webhookEndpoints.update(existing.id, { enabled_events: [...WEBHOOK_EVENTS] })
				webhook = withDrift({ id: existing.id, url, action: "updated" }, version)
			} else {
				webhook = withDrift({ id: existing.id, url, action: "exists" }, [...events, ...version])
			}
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
		product: productReport,
		prices,
		paymentLinks,
		portal,
		...(webhook ? { webhook } : {}),
	}
}
