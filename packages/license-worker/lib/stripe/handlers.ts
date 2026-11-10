/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One handler per accepted event type. Every handler re-reads state from Stripe by ID or acts only on the ledger.
 *   No handler reads an entitlement from the event body or decides a state. Each passes its observation to `policy.ts`
 *   and writes the answer. Each is safe to run twice. The mint answers `already_minted` on a repeat.
 *   Row creation finds the existing row. State writes are idempotent.
 */

import type Stripe from "stripe"

import { todayUTC } from "#dates"
import type { LicenseWorkerEnv } from "#env"
import { ensureLicenseFromCheckoutSession, type FulfilDependencies, fulfilInvoice } from "#fulfil"
import type { Ledger } from "#ledger/client"
import { currentToken, findLicense, findLicenseBySubscription, findTokenLid, setLicenseState } from "#ledger/licenses"
import { LicenseState, type LicenseRow } from "#ledger/schema"
import { licenseStateAfterDispute, licenseStateAfterRefund, licenseStateAfterSubscription } from "#policy"
import { idOf, invoiceSubscriptionID } from "#stripe/shapes"

/**
 * The invoice a charge paid.
 *
 * A charge no longer names its invoice.
 * The link runs through the PaymentIntent.
 * The invoice-payments list is the query that answers it.
 */
async function invoiceIDForCharge(stripe: Stripe, charge: Stripe.Charge): Promise<string | null> {
	const paymentIntent = idOf(charge.payment_intent)

	if (!paymentIntent) return null

	const payments = await stripe.invoicePayments.list({
		payment: { type: "payment_intent", payment_intent: paymentIntent },
		limit: 1,
	})

	return idOf(payments.data[0]?.invoice)
}

/**
 * Write the state a handler decided from the row it read.
 *
 * A conflict throws, so the webhook route answers 500 without recording the event.
 * Stripe then redelivers it, and the handler decides again from the row as it stands.
 */
async function transitionLicense(
	ledger: Ledger,
	license: LicenseRow,
	to: LicenseState,
	also: { subscriptionState?: string; paymentState?: string },
	event: Stripe.Event
): Promise<void> {
	const outcome = await setLicenseState(ledger, license.lid, { from: license.license_state, to }, also)

	if (outcome === "conflict") {
		throw new Error(
			`license ${license.lid} left ${license.license_state} while ${event.type} ${event.id} was handled; Stripe redelivers the event`
		)
	}
}

export async function handleStripeEvent(
	env: LicenseWorkerEnv,
	deps: FulfilDependencies,
	event: Stripe.Event
): Promise<{ handled: string }> {
	switch (event.type) {
		case "checkout.session.completed": {
			const session = await deps.stripe.checkout.sessions.retrieve(event.data.object.id, { expand: ["line_items"] })

			if (session.mode !== "subscription") return { handled: "not a subscription checkout" }

			await ensureLicenseFromCheckoutSession(env, deps, session)

			return { handled: "license row ensured" }
		}

		case "invoice.paid": {
			const result = await fulfilInvoice(env, deps, event.data.object.id)

			return { handled: result.result === "refused" ? `refused: ${result.reason}` : result.result }
		}

		case "invoice.payment_failed": {
			const subscriptionID = invoiceSubscriptionID(event.data.object)
			const license = subscriptionID ? await findLicenseBySubscription(deps.ledger, subscriptionID) : null

			if (!license) return { handled: "no license for invoice" }

			await transitionLicense(deps.ledger, license, license.license_state, { paymentState: "past_due" }, event)

			return { handled: "payment state recorded" }
		}

		case "customer.subscription.updated":
		case "customer.subscription.deleted": {
			const subscription = await deps.stripe.subscriptions.retrieve(event.data.object.id)
			const license = await findLicenseBySubscription(deps.ledger, subscription.id)

			if (!license) return { handled: "no license for subscription" }

			const token = await currentToken(deps.ledger, license.lid)

			const next = licenseStateAfterSubscription(license.license_state, subscription, {
				deleted: event.type === "customer.subscription.deleted",
				graceUntil: token?.expires,
				today: todayUTC(deps.now),
			})

			await transitionLicense(deps.ledger, license, next, { subscriptionState: subscription.status }, event)

			return { handled: `subscription ${subscription.status}` }
		}

		case "charge.refunded":
		case "charge.dispute.created": {
			const chargeID = event.type === "charge.refunded" ? event.data.object.id : idOf(event.data.object.charge)
			const charge = chargeID ? await deps.stripe.charges.retrieve(chargeID) : null
			const invoiceID = charge ? await invoiceIDForCharge(deps.stripe, charge) : null

			if (!charge || !invoiceID) return { handled: "no invoice on charge" }

			const lid = await findTokenLid(deps.ledger, invoiceID)
			const license = lid ? await findLicense(deps.ledger, lid) : null

			if (!license) return { handled: "no license for charge" }

			if (event.type === "charge.dispute.created") {
				await transitionLicense(deps.ledger, license, licenseStateAfterDispute(), { paymentState: "disputed" }, event)

				return { handled: "revoked" }
			}

			const next = licenseStateAfterRefund(license.license_state, charge)

			// A partial refund that leaves the state as it was also leaves the payment state.
			// A license a dispute revoked keeps `disputed`, so reconcile restores it
			// when Stripe rules the dispute won.
			if (next === license.license_state && charge.amount_refunded < charge.amount) {
				return { handled: `partial refund: ${next} unchanged` }
			}

			await transitionLicense(deps.ledger, license, next, { paymentState: "refunded" }, event)

			return { handled: next === LicenseState.Review ? "partial refund: review" : "revoked" }
		}

		default:
			return { handled: "ignored" }
	}
}
