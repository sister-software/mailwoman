/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines platform-free license access rules from Stripe observations.
 *   It also defines the public response for each state. Webhook handlers and reconciliation supply observations.
 *   Ledger functions persist each decision. Neither caller contains its own access rule.
 *
 *   State precedence runs from highest to lowest. A full refund or open dispute revokes access until the dispute is ruled
 *   in the customer's favor. The subscription determines the state again after that ruling. A partial refund triggers
 *   operator review. The public license status remains `active` during review, regardless of subscription status or token
 *   expiration, because the customer paid and the operator owns the review decision. Otherwise the subscription determines
 *   access. An ended subscription stays active until the current token expires. The token covers the paid period plus its
 *   grace period, so online status follows the same validity period as the offline token.
 */

import type Stripe from "stripe"

import { LicenseState } from "#ledger/schema"

export type PublicLicenseStatus = "active" | "lapsed" | "revoked"

/**
 * The word the public routes answer for a state.
 *
 * `review` maps to `active` because the customer paid and the operator must resolve the case.
 */
export function publicLicenseStatus(state: LicenseState): PublicLicenseStatus {
	return state === LicenseState.Review ? LicenseState.Active : state
}

export interface SubscriptionObservation {
	/**
	 * `customer.subscription.deleted` arrived.
	 * The status by itself may still indicate otherwise.
	 */
	deleted?: boolean
	/**
	 * The current token's `expires`, a UTC calendar date.
	 * Absent when no token has been minted.
	 */
	graceUntil?: string | null
	/**
	 * Today, a UTC calendar date.
	 */
	today: string
}

/**
 * The license state implied by a subscription's current state.
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
	return observation.graceUntil != null && observation.today <= observation.graceUntil
		? LicenseState.Active
		: LicenseState.Lapsed
}

/**
 * A full refund revokes the license.
 *
 * The operator reviews a partial refund.
 * The license reads `active` during that review.
 */
export function licenseStateAfterRefund(charge: Pick<Stripe.Charge, "amount" | "amount_refunded">): LicenseState {
	return charge.amount_refunded < charge.amount ? LicenseState.Review : LicenseState.Revoked
}

/**
 * A dispute revokes the license until Stripe rules it won.
 */
export function licenseStateAfterDispute(): LicenseState {
	return LicenseState.Revoked
}
