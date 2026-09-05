/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fulfilment: one paid invoice becomes one signed token. Everything checked here is re-read from Stripe by id — the
 *   invoice, its subscription, and when the license row does not exist yet, the Checkout Session — so a webhook body is
 *   never the source of an entitlement. The ledger's primary keys are the idempotency: a second mint for one invoice
 *   answers `already_minted`, and two events for one payment in either order produce one token.
 */

import { encodeLicenseKey, type LicenseKeyPayload } from "@mailwoman/core/license/key"
import type Stripe from "stripe"

import { calendarDateUTC, plusDays } from "#dates"
import type { EmailProvider } from "#email/provider"
import type { LicenseWorkerEnv } from "#env"
import { newLicenseID, newRefreshSecret, secretDigest } from "#identifiers"
import type { Ledger } from "#ledger/client"
import {
	createLicense,
	findLicenseBySubscription,
	findToken,
	insertToken,
	setEmailState,
	setPlanCode,
} from "#ledger/licenses"
import type { EmailState, LicenseRow, LicenseTokenRow } from "#ledger/schema"
import { planForPrice } from "#plans"

export interface FulfilDependencies {
	stripe: Stripe
	ledger: Ledger
	email: EmailProvider
}

export type FulfilOutcome =
	| { outcome: "minted" | "already_minted"; lid: string; invoiceID: string }
	| { outcome: "refused"; reason: string }

/**
 * The Payment Link's custom field that collects the licensee's legal name; the key is set on the Payment Link.
 */
const LICENSEE_FIELD_KEY = "licensee_legal_name"

function idOf(value: string | { id: string } | null | undefined): string | undefined {
	return typeof value === "string" ? value : value?.id
}

/**
 * The subscription an invoice bills. Stripe moved this from `invoice.subscription` to
 * `invoice.parent.subscription_details.subscription` across API versions; the pinned SDK types the newer shape and
 * older objects in a test fixture may carry the older one, so both are read.
 */
function invoiceSubscriptionID(invoice: Stripe.Invoice): string | undefined {
	const parent = invoice.parent?.subscription_details?.subscription
	const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription

	return idOf(parent) ?? idOf(legacy)
}

/**
 * The Price a line bills. The pinned SDK reads it from `pricing.price_details.price`; the older shape is `price`.
 */
function linePriceID(line: Stripe.InvoiceLineItem): string | undefined {
	const priced = line.pricing?.price_details?.price
	const legacy = (line as unknown as { price?: string | { id: string } | null }).price

	return idOf(priced) ?? idOf(legacy)
}

/**
 * The subscription's current period end, read from its first item, where the pinned SDK puts it, with the older
 * subscription-level field as the fallback.
 */
function subscriptionPeriodEnd(subscription: Stripe.Subscription): number | undefined {
	const item = subscription.items.data[0]?.current_period_end
	const legacy = (subscription as unknown as { current_period_end?: number }).current_period_end

	return item ?? legacy
}

/**
 * The license row for a Checkout Session: created on first sight with a fresh lid and refresh secret, read back after.
 * Mints no token; `invoice.paid` does. The refresh secret is stored by digest and held in plaintext only until the
 * first claim reads it.
 */
export async function ensureLicenseFromCheckoutSession(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	session: Stripe.Checkout.Session
): Promise<LicenseRow> {
	const subscriptionID = idOf(session.subscription)

	if (!subscriptionID) throw new Error(`checkout session ${session.id} carries no subscription`)

	const existing = await findLicenseBySubscription(deps.ledger, subscriptionID)

	if (existing) return existing

	const licensee = session.custom_fields.find((field) => field.key === LICENSEE_FIELD_KEY)?.text?.value?.trim()
	const email = session.customer_details?.email ?? undefined
	const customerID = idOf(session.customer)

	if (!licensee) throw new Error(`checkout session ${session.id} carries no licensee legal name`)

	if (!email || !customerID) throw new Error(`checkout session ${session.id} carries no customer email or id`)

	if (session.consent?.terms_of_service !== "accepted")
		throw new Error(`checkout session ${session.id} records no terms acceptance`)

	const priceID = idOf(session.line_items?.data[0]?.price)
	const plan = priceID ? planForPrice(env, priceID) : undefined
	const refreshSecret = newRefreshSecret()

	await createLicense(deps.ledger, {
		lid: newLicenseID(),
		subscription_id: subscriptionID,
		customer_id: customerID,
		checkout_session_id: session.id,
		plan_code: plan?.code ?? "pending",
		agreement_version: env.AGREEMENT_VERSION,
		licensee,
		email,
		refresh_secret_sha256: await secretDigest(refreshSecret),
		refresh_secret_pending: refreshSecret,
	})

	const created = await findLicenseBySubscription(deps.ledger, subscriptionID)

	if (!created) throw new Error(`license row for ${subscriptionID} vanished after insert`)

	return created
}

/**
 * Mint for one invoice.
 */
export async function fulfilInvoice(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	invoiceID: string
): Promise<FulfilOutcome> {
	if (!env.issuanceEnabled) return { outcome: "refused", reason: "issuance is disabled" }

	const existingToken = await findToken(deps.ledger, invoiceID)

	if (existingToken) return { outcome: "already_minted", lid: existingToken.lid, invoiceID }

	const invoice = await deps.stripe.invoices.retrieve(invoiceID)

	if (invoice.status !== "paid")
		return { outcome: "refused", reason: `invoice ${invoiceID} is ${invoice.status}, not paid` }

	if (invoice.livemode !== env.liveMode)
		return { outcome: "refused", reason: `invoice ${invoiceID} livemode does not match this environment` }

	const subscriptionID = invoiceSubscriptionID(invoice)

	if (!subscriptionID) return { outcome: "refused", reason: `invoice ${invoiceID} carries no subscription` }

	const lines = invoice.lines.data
	const line = lines[0]

	if (lines.length !== 1 || !line || (line.quantity ?? 1) !== 1) {
		return {
			outcome: "refused",
			reason: `invoice ${invoiceID} has ${lines.length} lines; one line at quantity 1 is expected`,
		}
	}

	const priceID = linePriceID(line)
	const plan = priceID ? planForPrice(env, priceID) : undefined

	if (!plan || !priceID) {
		return {
			outcome: "refused",
			reason: `invoice ${invoiceID} bills Price ${priceID ?? "none"}, which is not in the catalog`,
		}
	}

	const subscription = await deps.stripe.subscriptions.retrieve(subscriptionID)
	const periodEnd = subscriptionPeriodEnd(subscription)

	if (periodEnd === undefined)
		return { outcome: "refused", reason: `subscription ${subscriptionID} carries no period end` }

	let license = await findLicenseBySubscription(deps.ledger, subscriptionID)

	if (!license) {
		const sessions = await deps.stripe.checkout.sessions.list({
			subscription: subscriptionID,
			limit: 1,
			expand: ["data.line_items"],
		})

		const session = sessions.data[0]

		if (!session) return { outcome: "refused", reason: `no Checkout Session found for subscription ${subscriptionID}` }

		license = await ensureLicenseFromCheckoutSession(env, deps, session)
	}

	if (license.plan_code !== plan.code) {
		await setPlanCode(deps.ledger, license.lid, plan.code)
	}

	const issued = calendarDateUTC(invoice.status_transitions.paid_at ?? invoice.created)
	const expires = plusDays(calendarDateUTC(periodEnd), plan.graceDays)

	const payload: LicenseKeyPayload = {
		v: 1,
		kid: env.LICENSE_SIGNING_KID,
		licensee: license.licensee,
		issued,
		expires,
		scope: plan.scope,
		terms: plan.terms,
		lid: license.lid,
		agreement: plan.agreement,
	}

	const token = await encodeLicenseKey(payload, env.LICENSE_SIGNING_KEY_PEM)

	await insertToken(deps.ledger, {
		invoice_id: invoiceID,
		lid: license.lid,
		issued,
		expires,
		payload_json: JSON.stringify(payload),
		token,
	})

	await sendTokenEmail(deps, license, { invoice_id: invoiceID, token, issued, expires })

	return { outcome: "minted", lid: license.lid, invoiceID }
}

/**
 * Send a token to its licensee under the invoice id and record the outcome. The refresh secret rides along while it is
 * still pending, so a re-send after a failed first attempt carries what the first would have. A provider failure is
 * recorded as `failed` for the reconciliation pass; it never fails the mint.
 */
export async function sendTokenEmail(
	deps: Pick<FulfilDependencies, "ledger" | "email">,
	license: LicenseRow,
	token: Pick<LicenseTokenRow, "invoice_id" | "token" | "issued" | "expires">
): Promise<EmailState> {
	try {
		const { messageID } = await deps.email.send(
			{
				to: license.email,
				licensee: license.licensee,
				token: token.token,
				lid: license.lid,
				issued: token.issued,
				expires: token.expires,
				...(license.refresh_secret_pending ? { refreshSecret: license.refresh_secret_pending } : {}),
			},
			token.invoice_id
		)

		await setEmailState(deps.ledger, token.invoice_id, "sent", messageID)

		return "sent"
	} catch {
		await setEmailState(deps.ledger, token.invoice_id, "failed")

		return "failed"
	}
}
