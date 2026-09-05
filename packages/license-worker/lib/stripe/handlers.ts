/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One handler per accepted event type. Every handler re-reads state from Stripe by id or acts only on the ledger; none
 *   reads an entitlement from the event body. Each is safe to run twice: the mint answers `already_minted`, the row
 *   creation finds the row, and the state writes are idempotent.
 */

import type Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"
import { ensureLicenseFromCheckoutSession, type FulfilDependencies, fulfilInvoice } from "#fulfil"
import { findLicenseBySubscription, findTokenLid, setLicenseState } from "#ledger/licenses"
import { LicenseState } from "#ledger/schema"

function idOf(value: string | { id: string } | null | undefined): string | undefined {
	return typeof value === "string" ? value : value?.id
}

/**
 * The subscription an invoice bills, across the two shapes Stripe has used for it.
 */
function invoiceSubscriptionID(invoice: { id: string }): string | undefined {
	const shaped = invoice as {
		parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null
		subscription?: string | { id: string } | null
	}

	return idOf(shaped.parent?.subscription_details?.subscription) ?? idOf(shaped.subscription)
}

/**
 * The invoice a charge paid. A charge no longer names its invoice; the link runs through the PaymentIntent, and the
 * invoice-payments list is the one query that answers it.
 */
async function invoiceIDForCharge(stripe: Stripe, charge: Stripe.Charge): Promise<string | undefined> {
	const paymentIntent = idOf(charge.payment_intent)

	if (!paymentIntent) return undefined

	const payments = await stripe.invoicePayments.list({
		payment: { type: "payment_intent", payment_intent: paymentIntent },
		limit: 1,
	})

	return idOf(payments.data[0]?.invoice)
}

/**
 * What a subscription's current state says the license state should be. A revoked license stays revoked whatever the
 * subscription does; a `review` license stays under review; otherwise a subscription that has ended lapses the license
 * and any other status keeps it active.
 */
export function licenseStateFromSubscription(
	current: LicenseState,
	subscription: Pick<Stripe.Subscription, "status">,
	options: { deleted?: boolean } = {}
): LicenseState {
	if (current === LicenseState.Revoked || current === LicenseState.Review) return current

	const ended = options.deleted === true || subscription.status === "canceled" || subscription.status === "unpaid"

	return ended ? LicenseState.Lapsed : LicenseState.Active
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
			const outcome = await fulfilInvoice(env, deps, event.data.object.id)

			return { handled: outcome.outcome === "refused" ? `refused: ${outcome.reason}` : outcome.outcome }
		}

		case "invoice.payment_failed": {
			const subscriptionID = invoiceSubscriptionID(event.data.object)
			const license = subscriptionID ? await findLicenseBySubscription(deps.ledger, subscriptionID) : undefined

			if (!license) return { handled: "no license for invoice" }

			await setLicenseState(deps.ledger, license.lid, license.license_state, { paymentState: "past_due" })

			return { handled: "payment state recorded" }
		}

		case "customer.subscription.updated":
		case "customer.subscription.deleted": {
			const subscription = await deps.stripe.subscriptions.retrieve(event.data.object.id)
			const license = await findLicenseBySubscription(deps.ledger, subscription.id)

			if (!license) return { handled: "no license for subscription" }

			const next = licenseStateFromSubscription(license.license_state, subscription, {
				deleted: event.type === "customer.subscription.deleted",
			})

			await setLicenseState(deps.ledger, license.lid, next, { subscriptionState: subscription.status })

			return { handled: `subscription ${subscription.status}` }
		}

		case "charge.refunded":
		case "charge.dispute.created": {
			const chargeID = event.type === "charge.refunded" ? event.data.object.id : idOf(event.data.object.charge)
			const charge = chargeID ? await deps.stripe.charges.retrieve(chargeID) : undefined
			const invoiceID = charge ? await invoiceIDForCharge(deps.stripe, charge) : undefined

			if (!charge || !invoiceID) return { handled: "no invoice on charge" }

			const lid = await findTokenLid(deps.ledger, invoiceID)

			if (!lid) return { handled: "no license for charge" }

			const partial = event.type === "charge.refunded" && charge.amount_refunded < charge.amount

			await setLicenseState(deps.ledger, lid, partial ? LicenseState.Review : LicenseState.Revoked, {
				paymentState: event.type === "charge.refunded" ? "refunded" : "disputed",
			})

			return { handled: partial ? "partial refund: review" : "revoked" }
		}

		default:
			return { handled: "ignored" }
	}
}
