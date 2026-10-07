/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fulfillment turns one paid invoice into one signed token. The worker re-reads the invoice and its subscription
 *   from Stripe by id. When the license row does not exist, it also re-reads the Checkout Session. A webhook body
 *   never grants an entitlement. The ledger's unique keys make minting idempotent: a second mint for one invoice
 *   returns `already_minted`. Two events for one payment produce one token in either order. Two callers racing
 *   for one invoice or subscription receive defined answers, with one row between them. The keys do not prevent
 *   duplicate email. The losing caller can find the winner's token while its email is pending and send it too.
 *   The provider's idempotency key closes that window when the provider honors it.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { encodeLicenseKey, type LicenseKeyPayload } from "@mailwoman/core/license/key"
import type Stripe from "stripe"

import { calendarDateUTC, plusDays } from "#dates"
import type { EmailProvider } from "#email/provider"
import type { LicenseWorkerEnv } from "#env"
import { newLicenseID, newRefreshSecret, secretDigest } from "#identifiers"
import type { Ledger } from "#ledger/client"
import {
	createLicenseIfAbsent,
	findLicense,
	findLicenseBySubscription,
	findToken,
	insertTokenIfAbsent,
	setEmailState,
	setPlanCode,
} from "#ledger/licenses"
import type { LicenseRow, LicenseTokenRow } from "#ledger/schema"
import { planForPrice } from "#plans"
import { AGREEMENT_METADATA_KEY, AGREEMENT_VERSION, LICENSEE_FIELD_KEY } from "#shop/catalog"
import { idOf, invoiceSubscriptionID, linePriceID } from "#stripe/shapes"

export interface FulfilDependencies {
	stripe: Stripe
	ledger: Ledger
	email: EmailProvider
	/**
	 * The clock, in milliseconds; `Date.now` unless a test injects one.
	 *
	 * Read where a date decides a state.
	 */
	now?: () => number
}

export type FulfilResult =
	| { result: "minted" | "already_minted"; lid: string; invoiceID: string }
	| { result: "refused"; reason: string }

/**
 * The license row for a Checkout Session.
 *
 * The first caller creates it with a fresh lid and refresh secret.
 * Later callers read that row back, including when a concurrent caller created it first.
 *
 * Mints no token; `invoice.paid` does.
 * The refresh secret is stored by digest and held in plaintext only until the first claim reads it.
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

	const agreement = session.metadata?.[AGREEMENT_METADATA_KEY]

	if (!agreement) throw new Error(`checkout session ${session.id} carries no ${AGREEMENT_METADATA_KEY} metadata`)

	if (agreement !== AGREEMENT_VERSION) {
		console.warn(
			`checkout session ${session.id} accepted agreement ${agreement}; the catalog sells ${AGREEMENT_VERSION}`
		)
	}

	const priceID = idOf(session.line_items?.data[0]?.price)
	const plan = priceID ? planForPrice(env, priceID) : null
	const refreshSecret = newRefreshSecret()

	await createLicenseIfAbsent(deps.ledger, {
		lid: newLicenseID(),
		subscription_id: subscriptionID,
		customer_id: customerID,
		checkout_session_id: session.id,
		plan_code: plan?.code ?? "pending",
		agreement_version: agreement,
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
 * One paid invoice to one token: refused with a reason when the invoice, its Price
 * or its subscription is not one this worker mints for, `already_minted` when the ledger
 * holds the token, `minted` once the token is inserted and the email attempted.
 */
export async function fulfilInvoice(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	invoiceID: string
): Promise<FulfilResult> {
	if (!env.issuanceEnabled) return { result: "refused", reason: "issuance is disabled" }

	const existingToken = await findToken(deps.ledger, invoiceID)

	if (existingToken) return alreadyMinted(deps, existingToken)

	const invoice = await deps.stripe.invoices.retrieve(invoiceID)

	if (invoice.status !== "paid")
		return { result: "refused", reason: `invoice ${invoiceID} is ${invoice.status}, not paid` }

	if (invoice.livemode !== env.liveMode)
		return { result: "refused", reason: `invoice ${invoiceID} livemode does not match this environment` }

	const subscriptionID = invoiceSubscriptionID(invoice)

	if (!subscriptionID) return { result: "refused", reason: `invoice ${invoiceID} carries no subscription` }

	const lines = invoice.lines.data
	const line = lines[0]

	if (lines.length !== 1 || !line || (line.quantity ?? 1) !== 1) {
		return {
			result: "refused",
			reason: `invoice ${invoiceID} has ${lines.length} lines; one line at quantity 1 is expected`,
		}
	}

	const priceID = linePriceID(line)
	const plan = priceID ? planForPrice(env, priceID) : null

	if (!plan || !priceID) {
		return {
			result: "refused",
			reason: `invoice ${invoiceID} bills Price ${priceID ?? "none"}, which is not in the catalog`,
		}
	}

	// The line's own period rather than the subscription's current one: a replayed or backfilled
	// invoice after a later renewal must mint the period it paid for, never the newer one.
	const periodEnd = line.period?.end

	if (periodEnd === undefined) return { result: "refused", reason: `invoice ${invoiceID} line carries no period end` }

	let license = await findLicenseBySubscription(deps.ledger, subscriptionID)

	if (!license) {
		const sessions = await deps.stripe.checkout.sessions.list({
			subscription: subscriptionID,
			limit: 1,
			expand: ["data.line_items"],
		})

		const session = sessions.data[0]

		if (!session) return { result: "refused", reason: `no Checkout Session found for subscription ${subscriptionID}` }

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
		agreement: license.agreement_version,
	}

	const token = await encodeLicenseKey(payload, env.LICENSE_SIGNING_KEY_PEM)

	const inserted = await insertTokenIfAbsent(deps.ledger, {
		invoice_id: invoiceID,
		lid: license.lid,
		issued,
		expires,
		payload_json: stringifyJSON(payload),
		token,
	})

	if (inserted === "present") {
		// Another mint for this invoice landed between the read above and this insert.
		// Its row is the token.
		const winner = await findToken(deps.ledger, invoiceID)

		if (!winner) throw new Error(`token for ${invoiceID} vanished after a concurrent insert`)

		return alreadyMinted(deps, winner)
	}

	await sendTokenEmail(deps, license, { invoice_id: invoiceID, token, issued, expires })

	return { result: "minted", lid: license.lid, invoiceID }
}

/**
 * The answer for an invoice whose token exists.
 *
 * A crash between insert and send leaves the email pending.
 * A retry that finds the token sends it.
 */
async function alreadyMinted(deps: FulfilDependencies, token: LicenseTokenRow): Promise<FulfilResult> {
	if (token.email_state !== "sent") {
		const holder = await findLicense(deps.ledger, token.lid)

		if (holder) {
			await sendTokenEmail(deps, holder, token)
		}
	}

	return { result: "already_minted", lid: token.lid, invoiceID: token.invoice_id }
}

/**
 * What one send attempt came to.
 *
 * `failed` is the provider's refusal, recorded as such so the reconciliation pass sends again.
 * A failure to record either answer throws.
 *
 * The row keeps its earlier state, so reconciliation sends again.
 * After an accepted send, that retry can deliver the message twice.
 */
export type SendResult = { state: "sent" } | { state: "failed"; reason: string }

/**
 * Send a token to its licensee under the invoice id and record the result.
 *
 * The refresh secret remains available while the plaintext is still pending, so a re-send
 * before the first claim includes what the first would have.
 */
export async function sendTokenEmail(
	deps: Pick<FulfilDependencies, "ledger" | "email">,
	license: LicenseRow,
	token: Pick<LicenseTokenRow, "invoice_id" | "token" | "issued" | "expires">
): Promise<SendResult> {
	let messageID: string

	try {
		;({ messageID } = await deps.email.send(
			{
				to: license.email,
				licensee: license.licensee,
				token: token.token,
				lid: license.lid,
				issued: token.issued,
				expires: token.expires,
				agreement: license.agreement_version,
				refreshSecret: license.refresh_secret_pending || null,
			},
			token.invoice_id
		))
	} catch (error) {
		await setEmailState(deps.ledger, token.invoice_id, "failed")

		return { state: "failed", reason: error instanceof Error ? error.message : String(error) }
	}

	await setEmailState(deps.ledger, token.invoice_id, "sent", messageID)

	return { state: "sent" }
}
