/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scheduled pass. Stripe is the authority on what was paid and what stands; this ledger is the authority on what
 *   was minted and sent. Three sweeps, each safe to repeat: a paid invoice in the window with no token is minted through
 *   the path the webhook takes; a token whose email failed is sent again under the same invoice id; and a license whose
 *   state disagrees with its subscription is corrected, including a dispute Stripe has since ruled in the customer's
 *   favour. The report names ids only.
 */

import type Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"
import { type FulfilDependencies, fulfilInvoice, sendTokenEmail } from "#fulfil"
import {
	allLicenses,
	currentToken,
	findLicense,
	findToken,
	setLicenseState,
	tokensWithFailedEmail,
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
	now?: () => number
}

const PAYMENT_STATE_DISPUTED = "disputed"

export async function reconcileLedger(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	options: ReconcileOptions
): Promise<ReconcileReport> {
	const report: ReconcileReport = { minted: [], resent: [], refused: [], corrected: [], failed: [] }
	const now = options.now ?? Date.now
	const since = Math.floor(now() / 1000) - options.sinceSeconds

	for await (const invoice of deps.stripe.invoices.list({ status: "paid", created: { gte: since }, limit: 100 })) {
		if (await findToken(deps.ledger, invoice.id)) continue

		const outcome = await fulfilInvoice(env, deps, invoice.id)

		if (outcome.outcome === "minted") {
			report.minted.push(invoice.id)
		} else if (outcome.outcome === "refused") {
			report.refused.push({ invoiceID: invoice.id, reason: outcome.reason })
		}
	}

	for (const token of await tokensWithFailedEmail(deps.ledger)) {
		const license = await findLicense(deps.ledger, token.lid)

		if (!license) continue

		if ((await sendTokenEmail(deps, license, token)) === "sent") {
			report.resent.push(token.invoice_id)
		}
	}

	for (const license of await allLicenses(deps.ledger)) {
		let next: LicenseState | undefined

		try {
			next = await stateStripeSays(deps.stripe, deps, license)
		} catch (error) {
			report.failed.push({ lid: license.lid, reason: error instanceof Error ? error.message : String(error) })

			continue
		}

		if (next === undefined || next === license.license_state) continue

		await setLicenseState(deps.ledger, license.lid, next)
		report.corrected.push({ lid: license.lid, from: license.license_state, to: next })
	}

	return report
}

/**
 * The state Stripe's current records say a license should hold, or `undefined` when Stripe has nothing to add. A refund
 * is final. A dispute that Stripe has ruled `won` hands the license back to its subscription's state; any other dispute
 * outcome leaves it revoked.
 */
async function stateStripeSays(
	stripe: Stripe,
	deps: FulfilDependencies,
	license: LicenseRow
): Promise<LicenseState | undefined> {
	const subscription = await stripe.subscriptions.retrieve(license.subscription_id)

	if (license.license_state !== LicenseState.Revoked) {
		return licenseStateFromSubscription(license.license_state, subscription)
	}

	if (license.payment_state !== PAYMENT_STATE_DISPUTED) return undefined

	const token = await currentToken(deps.ledger, license.lid)

	if (!token) return undefined

	const payments = await stripe.invoicePayments.list({ invoice: token.invoice_id, limit: 1 })
	const payment = payments.data[0]?.payment

	const paymentIntent =
		typeof payment?.payment_intent === "string" ? payment.payment_intent : payment?.payment_intent?.id

	if (!paymentIntent) return undefined

	const disputes = await stripe.disputes.list({ payment_intent: paymentIntent, limit: 1 })
	const dispute = disputes.data[0]

	if (dispute?.status !== "won") return undefined

	return licenseStateFromSubscription(LicenseState.Active, subscription)
}
