// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The ledger's three state machines: a commercial license's state with its payment and
 *   subscription columns, a declared license's state, and a token's or issuance's email state.
 *
 *   Each transition is pure and decides from the row's current state and one event.
 *   `policy.ts` decides what a Stripe observation means for a license, and the transitions here call it.
 *
 *   Each carrier writes through the ledger's compare-and-set, so a step decided
 *   from a state another writer has since left is refused.
 *   The `ledger-states` repository check refuses a write to these columns outside this module's carriers.
 */

import { defineStateMachine, type StateCarrier } from "@mailwoman/core/state-machine"
import type Stripe from "stripe"

import type { Ledger } from "#ledger/client"
import { setIssuanceEmailState } from "#ledger/declarations"
import { setEmailState, setLicenseState } from "#ledger/licenses"
import { type EmailState, LicenseState } from "#ledger/schema"
import { licenseStateAfterDispute, licenseStateAfterRefund, licenseStateAfterSubscription } from "#policy"

/**
 * The values the `payment_state` column holds besides its default.
 */
export const PaymentState = {
	PastDue: "past_due",
	Disputed: "disputed",
	DisputeWon: "dispute_won",
	Refunded: "refunded",
} as const

export type PaymentState = (typeof PaymentState)[keyof typeof PaymentState]

/**
 * What can happen to a commercial license.
 *
 * - `subscription`: a subscription event, with the status Stripe holds, whether it was
 *   the deletion event, the current token's expiry and today's date.
 * - `payment-failed`: an invoice payment failed.
 * - `dispute-opened`: a charge dispute opened.
 * - `refund`: a charge was refunded, in full or in part.
 * - `correction`: the reconciliation pass found the state Stripe's records imply,
 *   from `policy.ts`, and the payment state that goes with it.
 */
export type LicenseEvent =
	| {
			kind: "subscription"
			status: Stripe.Subscription.Status
			deleted: boolean
			graceUntil: string | null
			today: string
	  }
	| { kind: "payment-failed" }
	| { kind: "dispute-opened" }
	| { kind: "refund"; amount: number; amountRefunded: number }
	| { kind: "correction"; to: LicenseState; paymentState: PaymentState | null }

/**
 * The `licenses` columns a license step writes with its state.
 */
export interface LicenseRecord {
	subscriptionState: string
	paymentState: PaymentState
}

/**
 * Every value the `license_state` column holds, read from {@link LicenseState}.
 */
export const LICENSE_STATES: readonly LicenseState[] = Object.values(LicenseState)

/**
 * The date the example subscription events treat as today.
 */
const EXAMPLE_TODAY = "2026-11-11"

/**
 * One license event for each case the license transition distinguishes, keyed by its row label.
 *
 * The grace window of each subscription example is relative to {@link EXAMPLE_TODAY}.
 */
export const LICENSE_EVENTS = {
	"subscription active": {
		kind: "subscription",
		status: "active",
		deleted: false,
		graceUntil: null,
		today: EXAMPLE_TODAY,
	},
	"subscription canceled, in grace": {
		kind: "subscription",
		status: "canceled",
		deleted: false,
		graceUntil: "2026-11-20",
		today: EXAMPLE_TODAY,
	},
	"subscription deleted, past grace": {
		kind: "subscription",
		status: "active",
		deleted: true,
		graceUntil: "2026-11-01",
		today: EXAMPLE_TODAY,
	},
	"payment failed": { kind: "payment-failed" },
	"dispute opened": { kind: "dispute-opened" },
	"full refund": { kind: "refund", amount: 1000, amountRefunded: 1000 },
	"partial refund": { kind: "refund", amount: 1000, amountRefunded: 200 },
	"dispute won": { kind: "correction", to: LicenseState.Active, paymentState: PaymentState.DisputeWon },
} as const satisfies Record<string, LicenseEvent>

/**
 * A commercial license's state machine.
 */
export const licenseMachine = defineStateMachine<LicenseState, LicenseEvent, LicenseRecord>({
	name: "license",
	states: LICENSE_STATES,
	events: LICENSE_EVENTS,
	transition(state, event) {
		switch (event.kind) {
			case "subscription":
				return {
					next: licenseStateAfterSubscription(
						state,
						{ status: event.status },
						{ deleted: event.deleted, graceUntil: event.graceUntil, today: event.today }
					),
					record: { subscriptionState: event.status },
					effects: [],
				}
			case "payment-failed":
				return { next: state, record: { paymentState: PaymentState.PastDue }, effects: [] }
			case "dispute-opened":
				return { next: licenseStateAfterDispute(), record: { paymentState: PaymentState.Disputed }, effects: [] }
			case "refund": {
				const next = licenseStateAfterRefund(state, { amount: event.amount, amount_refunded: event.amountRefunded })

				// A partial refund that leaves the state as it was also leaves the payment state.
				// A license a dispute revoked keeps `disputed`, so reconciliation restores it
				// when Stripe rules the dispute won.
				if (next === state && event.amountRefunded < event.amount) return { next, record: {}, effects: [] }

				return { next, record: { paymentState: PaymentState.Refunded }, effects: [] }
			}
			case "correction":
				return {
					next: event.to,
					record: event.paymentState ? { paymentState: event.paymentState } : {},
					effects: [],
				}
		}
	},
})

/**
 * The `licenses` row of `lid` as the license machine's carrier.
 */
export function licenseCarrier(ledger: Ledger, lid: string): StateCarrier<LicenseState, LicenseRecord> {
	return {
		async compareAndSet(from, to, record) {
			const written = await setLicenseState(ledger, lid, { from, to }, record)

			return written === "updated"
		},
	}
}

/**
 * What can happen to a declared license: the operator sets its state.
 */
export interface DeclarationEvent {
	kind: "operator-set"
	to: LicenseState
}

/**
 * A declared license's state machine.
 *
 * Only the operator moves a declaration, to any state.
 * Its carrier is the remote ledger, written through `wrangler d1 execute` by
 * the `shop.declaration-state` operation.
 */
export const declarationMachine = defineStateMachine<LicenseState, DeclarationEvent>({
	name: "declaration",
	states: LICENSE_STATES,
	events: Object.fromEntries(
		LICENSE_STATES.map((to): [string, DeclarationEvent] => [`operator sets ${to}`, { kind: "operator-set", to }])
	),
	transition(_state, event) {
		return { next: event.to, record: {}, effects: [] }
	},
})

/**
 * What can happen to a token's or issuance's email: the provider accepted it,
 * with its message id, or refused it.
 */
export type EmailEvent = { kind: "sent"; messageID: string } | { kind: "failed" }

/**
 * The column an email step writes with its state.
 */
export interface EmailRecord {
	messageID: string
}

/**
 * Every value the `email_state` columns of `license_tokens` and `issuances` hold,
 * as their check constraints spell them.
 */
export const EMAIL_STATES: readonly EmailState[] = ["pending", "sent", "failed"]

/**
 * The two send outcomes the email machine takes, keyed by their row labels.
 */
export const EMAIL_EVENTS = {
	sent: { kind: "sent", messageID: "msg_1" },
	failed: { kind: "failed" },
} as const satisfies Record<string, EmailEvent>

/**
 * The email state machine of a token or an issuance.
 *
 * A sent email stays sent.
 * The resend lists only `pending` and `failed`, so a send after `sent` is a duplicate,
 * and its outcome leaves the row as it is.
 */
export const emailMachine = defineStateMachine<EmailState, EmailEvent, EmailRecord>({
	name: "email",
	states: EMAIL_STATES,
	events: EMAIL_EVENTS,
	transition(state, event) {
		if (state === "sent") return { next: state, record: {}, effects: [] }

		return event.kind === "sent"
			? { next: "sent", record: { messageID: event.messageID }, effects: [] }
			: { next: "failed", record: {}, effects: [] }
	},
})

/**
 * The `license_tokens` row of `invoiceID` as the email machine's carrier.
 */
export function tokenEmailCarrier(ledger: Ledger, invoiceID: string): StateCarrier<EmailState, EmailRecord> {
	return {
		async compareAndSet(from, to, record) {
			return (await setEmailState(ledger, invoiceID, { from, to }, record.messageID ?? null)) === "updated"
		},
	}
}

/**
 * The `issuances` row of `issuanceID` as the email machine's carrier.
 */
export function issuanceEmailCarrier(ledger: Ledger, issuanceID: string): StateCarrier<EmailState, EmailRecord> {
	return {
		async compareAndSet(from, to, record) {
			return (await setIssuanceEmailState(ledger, issuanceID, { from, to }, record.messageID ?? null)) === "updated"
		},
	}
}
