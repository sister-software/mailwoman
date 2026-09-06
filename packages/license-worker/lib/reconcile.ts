/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scheduled pass. Stripe is the authority on what was paid and what stands; this ledger is the authority on what
 *   was minted and sent. Three sweeps, each safe to repeat: a paid invoice with no token is minted through the path the
 *   webhook takes; a token whose email is not confirmed sent goes again under the same invoice id; and a license whose
 *   state disagrees with its subscription is corrected, including a dispute Stripe has since ruled in the customer's
 *   favour. One item's failure is recorded against that item and the sweep goes on; a listing that cannot be completed
 *   is recorded as such, so an empty sweep is never mistaken for a clean one. The report names ids only.
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
import { type LicenseRow, LicenseState, type LicenseTokenRow } from "#ledger/schema"
import { licenseStateFromSubscription } from "#stripe/handlers"

export type ReconcileStage = "mint" | "email" | "state"

/**
 * One item the pass could not finish, with the id the next operator action needs: the invoice for a mint, the invoice
 * and the license for a delivery, the license for a state correction.
 */
export type ReconcileFailure =
	| { stage: "mint"; invoiceID: string; reason: string }
	| { stage: "email"; invoiceID: string; lid: string; reason: string }
	| { stage: "state"; lid: string; reason: string }

export interface ReconcileReport {
	minted: string[]
	resent: string[]
	refused: Array<{ invoiceID: string; reason: string }>
	corrected: Array<{ lid: string; from: LicenseState; to: LicenseState }>
	/**
	 * Items that failed on their own; each is retried by the next pass.
	 */
	failed: ReconcileFailure[]
	/**
	 * Sweeps whose listing failed part way: the items after the failure were never seen this pass.
	 */
	incomplete: Array<{ stage: ReconcileStage; reason: string }>
}

export interface ReconcileOptions {
	/**
	 * How far back to list paid invoices, by the invoice's creation time. Wider than the cron interval, so a pass that
	 * fails leaves nothing unminted.
	 */
	sinceSeconds: number
}

const PAYMENT_STATE_DISPUTED = "disputed"
const PAYMENT_STATE_REFUNDED = "refunded"

const EMAIL_ADDRESS = /[^\s@<>"']+@[^\s@<>"']+/gu
const LONG_OPAQUE_VALUE = /[A-Za-z0-9_-]{40,}/gu
const REASON_LENGTH = 200

/**
 * An error as the report carries it: the message, with anything shaped like an address or a token or secret struck,
 * since the report is logged.
 */
export function failureReason(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)

	return text.replace(EMAIL_ADDRESS, "<email>").replace(LONG_OPAQUE_VALUE, "<redacted>").slice(0, REASON_LENGTH)
}

export async function reconcileLedger(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	options: ReconcileOptions
): Promise<ReconcileReport> {
	const report: ReconcileReport = { minted: [], resent: [], refused: [], corrected: [], failed: [], incomplete: [] }
	const since = Math.floor((deps.now ?? Date.now)() / 1000) - options.sinceSeconds

	try {
		for await (const invoice of deps.stripe.invoices.list({ status: "paid", created: { gte: since }, limit: 100 })) {
			await mintIfUnminted(env, deps, invoice.id, report)
		}
	} catch (error) {
		report.incomplete.push({ stage: "mint", reason: failureReason(error) })
	}

	let awaiting: LicenseTokenRow[] = []

	try {
		awaiting = await tokensAwaitingEmail(deps.ledger)
	} catch (error) {
		report.incomplete.push({ stage: "email", reason: failureReason(error) })
	}

	for (const token of awaiting) {
		try {
			const license = await findLicense(deps.ledger, token.lid)

			if (!license) throw new Error(`token ${token.invoice_id} names license ${token.lid}, which has no row`)

			const outcome = await sendTokenEmail(deps, license, token)

			if (outcome.state === "sent") {
				report.resent.push(token.invoice_id)
			} else {
				report.failed.push({
					stage: "email",
					invoiceID: token.invoice_id,
					lid: token.lid,
					reason: `provider refused: ${failureReason(outcome.reason)}`,
				})
			}
		} catch (error) {
			report.failed.push({ stage: "email", invoiceID: token.invoice_id, lid: token.lid, reason: failureReason(error) })
		}
	}

	let licenses: LicenseRow[] = []

	try {
		licenses = await allLicenses(deps.ledger)
	} catch (error) {
		report.incomplete.push({ stage: "state", reason: failureReason(error) })
	}

	for (const license of licenses) {
		try {
			const next = await stateStripeSays(deps.stripe, deps, license)

			if (next === undefined || next.state === license.license_state) continue

			await setLicenseState(
				deps.ledger,
				license.lid,
				next.state,
				next.paymentState ? { paymentState: next.paymentState } : {}
			)

			report.corrected.push({ lid: license.lid, from: license.license_state, to: next.state })
		} catch (error) {
			report.failed.push({ stage: "state", lid: license.lid, reason: failureReason(error) })
		}
	}

	return report
}

/**
 * Mint one listed invoice unless the ledger already holds its token; a failure is this invoice's alone.
 */
async function mintIfUnminted(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	invoiceID: string,
	report: ReconcileReport
): Promise<void> {
	try {
		if (await findToken(deps.ledger, invoiceID)) return

		const outcome = await fulfilInvoice(env, deps, invoiceID)

		if (outcome.outcome === "minted") {
			report.minted.push(invoiceID)
		} else if (outcome.outcome === "refused") {
			report.refused.push({ invoiceID, reason: outcome.reason })
		}
	} catch (error) {
		report.failed.push({ stage: "mint", invoiceID, reason: failureReason(error) })
	}
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
