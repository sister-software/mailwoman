/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scheduled pass. Stripe is the authority on what was paid and what stands; this ledger is the authority on what
 *   was minted and sent. Three sweeps, each safe to repeat: a paid invoice in the window with no token is minted through
 *   the path the webhook takes; a token whose email is not confirmed sent goes again under the same invoice id; and a license whose
 *   state disagrees with its subscription is corrected, including a dispute Stripe has since ruled in the customer's
 *   favour. The report names ids only.
 */

import type Stripe from "stripe"

import { todayUTC } from "#dates"
import type { LicenseWorkerEnv } from "#env"
import { type FulfilDependencies, fulfilInvoice, sendTokenEmail } from "#fulfil"
import {
	allLicenses,
	currentToken,
	findLicense,
	findToken,
	setLicenseState,
	tokensAwaitingEmail,
} from "#ledger/licenses"
import { type LicenseRow, LicenseState } from "#ledger/schema"
import { licenseStateFromSubscription } from "#stripe/handlers"

export interface ReconcileReport {
	minted: string[]
	resent: string[]
	refused: Array<{ invoiceID: string; reason: string }>
	corrected: Array<{ lid: string; from: LicenseState; to: LicenseState }>
	/**
	 * Licenses whose Stripe records could not be read this pass. One is never allowed to stop the sweep for the rest.
	 */
	failed: Array<{ lid: string; reason: string }>
}

export interface ReconcileOptions {
	/**
	 * How far back to list paid invoices. Wider than the cron interval, so a pass that fails leaves nothing unminted.
	 */
	sinceSeconds: number
}

const PAYMENT_STATE_DISPUTED = "disputed"
const PAYMENT_STATE_REFUNDED = "refunded"

export async function reconcileLedger(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	options: ReconcileOptions
): Promise<ReconcileReport> {
	const report: ReconcileReport = { minted: [], resent: [], refused: [], corrected: [], failed: [] }
	const since = Math.floor((deps.now ?? Date.now)() / 1000) - options.sinceSeconds

	for await (const invoice of deps.stripe.invoices.list({ status: "paid", created: { gte: since }, limit: 100 })) {
		if (await findToken(deps.ledger, invoice.id)) continue

		const outcome = await fulfilInvoice(env, deps, invoice.id)

		if (outcome.outcome === "minted") {
			report.minted.push(invoice.id)
		} else if (outcome.outcome === "refused") {
			report.refused.push({ invoiceID: invoice.id, reason: outcome.reason })
		}
	}

	for (const token of await tokensAwaitingEmail(deps.ledger)) {
		const license = await findLicense(deps.ledger, token.lid)

		if (!license) continue

		if ((await sendTokenEmail(deps, license, token)) === "sent") {
			report.resent.push(token.invoice_id)
		}
	}

	for (const license of await allLicenses(deps.ledger)) {
		let next: Correction | undefined

		try {
			next = await stateStripeSays(deps.stripe, deps, license)
		} catch (error) {
			report.failed.push({ lid: license.lid, reason: error instanceof Error ? error.message : String(error) })

			continue
		}

		if (next === undefined || next.state === license.license_state) continue

		await setLicenseState(
			deps.ledger,
			license.lid,
			next.state,
			next.paymentState ? { paymentState: next.paymentState } : {}
		)

		report.corrected.push({ lid: license.lid, from: license.license_state, to: next.state })
	}

	return report
}

interface Correction {
	state: LicenseState
	paymentState?: string
}

/**
 * The payment intent behind an invoice, through its payment record.
 */
async function paymentIntentOf(stripe: Stripe, invoiceID: string): Promise<string | undefined> {
	const payments = await stripe.invoicePayments.list({ invoice: invoiceID, limit: 1 })
	const payment = payments.data[0]?.payment

	return typeof payment?.payment_intent === "string" ? payment.payment_intent : payment?.payment_intent?.id
}

/**
 * Whether the charge behind an invoice has been refunded in full. Stripe's `refunded` is false for a partial refund,
 * which is the line the `charge.refunded` handler draws too.
 */
async function fullyRefunded(stripe: Stripe, invoiceID: string): Promise<boolean> {
	const paymentIntent = await paymentIntentOf(stripe, invoiceID)

	if (!paymentIntent) return false

	const charges = await stripe.charges.list({ payment_intent: paymentIntent, limit: 1 })

	return charges.data[0]?.refunded === true
}

/**
 * The state Stripe's current records say a license should hold, or `undefined` when Stripe has nothing to add. A full
 * refund is final, and it is read from the charge rather than the subscription, which a refund leaves `active`: a
 * license minted by the missed-invoice sweep, or one whose `charge.refunded` event never arrived, is revoked here at
 * the cost of two Stripe reads per active license per pass. A dispute that Stripe has ruled `won` hands the license
 * back to its subscription's state; any other dispute outcome leaves it revoked.
 */
async function stateStripeSays(
	stripe: Stripe,
	deps: FulfilDependencies,
	license: LicenseRow
): Promise<Correction | undefined> {
	const subscription = await stripe.subscriptions.retrieve(license.subscription_id)

	const token = await currentToken(deps.ledger, license.lid)
	const today = todayUTC(deps.now)

	if (license.license_state !== LicenseState.Revoked) {
		if (token && (await fullyRefunded(stripe, token.invoice_id))) {
			return { state: LicenseState.Revoked, paymentState: PAYMENT_STATE_REFUNDED }
		}

		return {
			state: licenseStateFromSubscription(license.license_state, subscription, { graceUntil: token?.expires, today }),
		}
	}

	if (license.payment_state !== PAYMENT_STATE_DISPUTED || !token) return undefined

	const paymentIntent = await paymentIntentOf(stripe, token.invoice_id)

	if (!paymentIntent) return undefined

	const disputes = await stripe.disputes.list({ payment_intent: paymentIntent, limit: 1 })
	const dispute = disputes.data[0]

	if (dispute?.status !== "won") return undefined

	return {
		state: licenseStateFromSubscription(LicenseState.Active, subscription, { graceUntil: token.expires, today }),
	}
}
