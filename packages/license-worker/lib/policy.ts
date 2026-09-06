/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The access-state rules, platform-free: what a license reads given what Stripe has said, and what the public routes
 *   answer for each state. The webhook handlers and the reconciliation pass supply the observations and the ledger
 *   functions persist the decision; neither holds a rule of its own.
 *
 *   Precedence, highest first. A revocation (a full refund, a dispute opened) stands until a dispute is ruled won, when
 *   the subscription decides again. A review (a partial refund) stands until an operator resolves it, whatever the
 *   subscription does and whether or not the current token's date has passed: the customer paid, and the question is
 *   the operator's, so the license reads `active` outside. Otherwise the subscription decides, and one that has ended
 *   keeps the license active until the current token's date passes, since the token carries the paid period plus its
 *   grace and online status must not refuse a license whose offline token is still good.
 */

import type Stripe from "stripe"

import { LicenseState } from "#ledger/schema"

export type PublicLicenseStatus = "active" | "lapsed" | "revoked"

/**
 * The word the public routes answer for a state. `review` reads `active`: the customer paid, and the question is the
 * operator's.
 */
export function publicLicenseStatus(state: LicenseState): PublicLicenseStatus {
	return state === LicenseState.Review ? LicenseState.Active : state
}

export interface SubscriptionObservation {
	/**
	 * `customer.subscription.deleted` arrived; the status alone may still read otherwise.
	 */
	deleted?: boolean
	/**
	 * The current token's `expires`, a UTC calendar date; absent when no token has been minted.
	 */
	graceUntil?: string
	/**
	 * Today, a UTC calendar date.
	 */
	today: string
}

/**
 * What a subscription's current state says the license state should be.
 */
export function licenseStateAfterSubscription(
	current: LicenseState,
	subscription: Pick<Stripe.Subscription, "status">,
	observation: SubscriptionObservation
): LicenseState {
	if (current === LicenseState.Revoked || current === LicenseState.Review) return current

	const ended = observation.deleted === true || subscription.status === "canceled" || subscription.status === "unpaid"

	if (!ended) return LicenseState.Active

	// Calendar dates compare as strings.
	return observation.graceUntil !== undefined && observation.today <= observation.graceUntil
		? LicenseState.Active
		: LicenseState.Lapsed
}

/**
 * What a refund says: a full refund revokes; a partial one is the operator's to review, and the license reads active
 * meanwhile.
 */
export function licenseStateAfterRefund(charge: Pick<Stripe.Charge, "amount" | "amount_refunded">): LicenseState {
	return charge.amount_refunded < charge.amount ? LicenseState.Review : LicenseState.Revoked
}

/**
 * What a dispute opened says: revoked, until Stripe rules it won.
 */
export function licenseStateAfterDispute(): LicenseState {
	return LicenseState.Revoked
}
