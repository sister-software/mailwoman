/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reconciles a Stripe account against the shop catalog.
 *
 *   The provisioner finds each object by a catalog key, such as a lookup key, a metadata mark or a URL,
 *   and never by a stored Stripe ID. It compares the object with the catalog. When `apply` is true, it
 *   creates missing objects, updates changeable fields and replaces objects whose fields are fixed at
 *   creation. When `apply` is false, it writes no object and reports the planned changes.
 *
 *   A Payment Link whose agreement version or consent collection differs is replaced, because Stripe
 *   fixes both at creation. A Price amount or a webhook API version that differs is only reported as
 *   drift, because changing either requires an operator decision.
 *
 *   Stripe returns the webhook signing secret only at creation, and only the report carries it.
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

/**
 * Options for {@link provisionShop}.
 */
export interface ProvisionInput {
	/**
	 * The docs site origin, from which the success, terms and return URLs derive.
	 */
	siteOrigin: string
	/**
	 * The deployed worker origin.
	 *
	 * The provisioner manages the webhook destination only when it is set.
	 */
	workerOrigin?: string
	/**
	 * Writes to Stripe when `true`.
	 * When `false`, the run only reports planned changes.
	 */
	apply: boolean
	log?: (line: string) => void
}

/**
 * The outcome for one object.
 *
 * - `exists`: The object matches the catalog or was left with reported drift.
 * - `updated`: An update brought the object in line with the catalog.
 * - `replaced`: The old object was deactivated and a successor was created.
 * - `created`: The object was created.
 * - `missing`: The object does not exist and the run did not create it.
 * - `blocked`: Stripe refused a required setting, such as consent collection before the terms URL is set.
 */
const ProvisionActionSchema = z.enum(["exists", "updated", "replaced", "created", "missing", "blocked"])

/**
 * The outcome for one provisioned object.
 */
export type ProvisionAction = z.infer<typeof ProvisionActionSchema>

const ProvisionedObjectSchema = z.object({
	id: z.string().optional(),
	action: ProvisionActionSchema,
	/**
	 * Differences between Stripe and the catalog that remain after the run.
	 * A read-only run reports every difference.
	 */
	drift: z.array(z.string()).optional(),
})

/**
 * The report entry for one provisioned object.
 */
export type ProvisionedObject = z.infer<typeof ProvisionedObjectSchema>

/**
 * The provisioning report schema.
 * `mwops shop` validates its output against it.
 */
export const ProvisionReportSchema = z.object({
	/**
	 * The terms page used by Payment Link consent collection, and whether every link has consent collection.
	 *
	 * Stripe takes the terms URL from the account's public details, which only the dashboard can set.
	 * The worker rejects sessions from a link without consent collection, so the provisioner
	 * marks such a link `blocked` instead of creating it without consent.
	 */
	terms: z.object({ url: z.string(), consent: z.boolean() }),
	product: ProvisionedObjectSchema,
	prices: z.record(z.enum(SHOP_PLAN_CODES), ProvisionedObjectSchema),
	paymentLinks: z.record(
		z.enum(SHOP_PLAN_CODES),
		ProvisionedObjectSchema.extend({ url: z.string().optional(), consent: z.boolean(), promotionCodes: z.boolean() })
	),
	/**
	 * The Customer Portal configuration.
	 *
	 * `url` is the login page where customers change their card or plan, or cancel.
	 */
	portal: ProvisionedObjectSchema.extend({ url: z.string().optional() }),
	webhook: ProvisionedObjectSchema.extend({ url: z.string(), secret: z.string().optional() }).optional(),
})

/**
 * The provisioning report.
 */
export type ProvisionReport = z.infer<typeof ProvisionReportSchema>

function planRecord<T>(build: (plan: ShopPlan) => T): Record<ShopPlan["code"], T> {
	return Object.fromEntries(SHOP_PLANS.map((plan) => [plan.code, build(plan)])) as Record<ShopPlan["code"], T>
}

/**
 * Returns the first matching item across every page of a Stripe list.
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
 * Reports whether two event lists contain the same events in any order.
 */
function sameEvents(held: readonly string[], wanted: readonly string[]): boolean {
	return held.length === wanted.length && wanted.every((event) => held.includes(event))
}

/**
 * Reconciles the Stripe account with the shop catalog and returns a report.
 */
export async function provisionShop(stripe: Stripe, input: ProvisionInput): Promise<ProvisionReport> {
	const log = input.log ?? (() => {})
	const urls = shopURLs(input.siteOrigin)

	// The flag stays true only while every Payment Link has consent collection.
	let consent = true

	// The Product is found by its metadata mark and checked against the agreement version.
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

	// Prices are found by lookup key.
	// Stripe Prices are immutable, so a difference is reported as drift.
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

	// Each plan has one Payment Link, identified by its `plan_code` metadata.
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

			// Stripe fixes these fields at creation, so a difference requires a new link.
			const replacement = [
				...differs(AGREEMENT_METADATA_KEY, existing.metadata[AGREEMENT_METADATA_KEY], AGREEMENT_VERSION),
				...differs("consent_collection.terms_of_service", existing.consent_collection?.terms_of_service, "required"),
			]

			// An update can change these fields in place.
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

			// The successor is created first, so the old link stays active if Stripe refuses the new one.
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

	// The Customer Portal configuration is found by its headline.
	// The check covers the terms URL, the
	// return URL and the enabled login page.
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

	// The webhook destination is found by URL, and its event list is reconciled.
	// An API version difference is only reported, because a new destination has a
	// new signing secret that the worker needs first.
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
