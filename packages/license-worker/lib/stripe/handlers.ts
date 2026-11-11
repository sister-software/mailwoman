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

import { applyStep, type MachineEffect, type StepOutcome } from "@mailwoman/core/state-machine"
import type Stripe from "stripe"

import { todayUTC } from "#dates"
import type { LicenseWorkerEnv } from "#env"
import { ensureLicenseFromCheckoutSession, type FulfilDependencies, fulfilInvoice } from "#fulfil"
import type { Ledger } from "#ledger/client"
import { currentToken, findLicense, findLicenseBySubscription, findTokenLid } from "#ledger/licenses"
import { type LicenseEvent, type LicenseRecord, licenseCarrier, licenseMachine } from "#ledger/machines"
import { LicenseState, type LicenseRow } from "#ledger/schema"
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
 * Apply the license machine's step for `licenseEvent` to the row the handler read.
 *
 * A conflict throws, so the webhook route answers 500 without recording the event.
 * Stripe then redelivers it, and the handler decides again from the row as it stands.
 */
async function transitionLicense(
	ledger: Ledger,
	license: LicenseRow,
	licenseEvent: LicenseEvent,
	event: Stripe.Event
): Promise<StepOutcome<LicenseState, LicenseRecord, MachineEffect>> {
	const outcome = await applyStep(
		licenseMachine,
		licenseCarrier(ledger, license.lid),
		license.license_state,
		licenseEvent
	)

	if (outcome.status === "conflict") {
		throw new Error(
			`license ${license.lid} left ${license.license_state} while ${event.type} ${event.id} was handled; Stripe redelivers the event`
		)
	}

	return outcome
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

			await transitionLicense(deps.ledger, license, { kind: "payment-failed" }, event)

			return { handled: "payment state recorded" }
		}

		case "customer.subscription.updated":
		case "customer.subscription.deleted": {
			const subscription = await deps.stripe.subscriptions.retrieve(event.data.object.id)
			const license = await findLicenseBySubscription(deps.ledger, subscription.id)

			if (!license) return { handled: "no license for subscription" }

			const token = await currentToken(deps.ledger, license.lid)

			await transitionLicense(
				deps.ledger,
				license,
				{
					kind: "subscription",
					status: subscription.status,
					deleted: event.type === "customer.subscription.deleted",
					graceUntil: token?.expires ?? null,
					today: todayUTC(deps.now),
				},
				event
			)

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
				await transitionLicense(deps.ledger, license, { kind: "dispute-opened" }, event)

				return { handled: "revoked" }
			}

			const outcome = await transitionLicense(
				deps.ledger,
				license,
				{ kind: "refund", amount: charge.amount, amountRefunded: charge.amount_refunded },
				event
			)

			const next = outcome.step.next

			if (outcome.status === "unchanged") return { handled: `partial refund: ${next} unchanged` }

			return { handled: next === LicenseState.Review ? "partial refund: review" : "revoked" }
		}

		default:
			return { handled: "ignored" }
	}
}
