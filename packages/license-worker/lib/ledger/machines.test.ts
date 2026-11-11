/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isNoopStep } from "@mailwoman/core/state-machine"
import { describe, expect, it } from "vitest"

import {
	declarationMachine,
	EMAIL_STATES,
	type EmailEvent,
	emailMachine,
	LICENSE_STATES,
	type LicenseEvent,
	licenseMachine,
	PaymentState,
} from "#ledger/machines"
import { type EmailState, LicenseState } from "#ledger/schema"

const TODAY = "2026-11-11"

/**
 * One event of each shape the license machine takes, keyed by the row label the table below uses.
 */
const LICENSE_EVENTS = {
	"subscription active": { kind: "subscription", status: "active", deleted: false, graceUntil: null, today: TODAY },
	"subscription canceled, in grace": {
		kind: "subscription",
		status: "canceled",
		deleted: false,
		graceUntil: "2026-11-20",
		today: TODAY,
	},
	"subscription deleted, past grace": {
		kind: "subscription",
		status: "active",
		deleted: true,
		graceUntil: "2026-11-01",
		today: TODAY,
	},
	"payment failed": { kind: "payment-failed" },
	"dispute opened": { kind: "dispute-opened" },
	"full refund": { kind: "refund", amount: 1000, amountRefunded: 1000 },
	"partial refund": { kind: "refund", amount: 1000, amountRefunded: 200 },
	"dispute won": { kind: "correction", to: LicenseState.Active, paymentState: PaymentState.DisputeWon },
} as const satisfies Record<string, LicenseEvent>

type LicenseEventName = keyof typeof LICENSE_EVENTS

/**
 * The expected next state of every (state, event) pair, written from the precedence in
 * `policy.ts`: a revocation outranks a review, and a review outranks the subscription.
 */
const LICENSE_TABLE: Record<LicenseState, Record<LicenseEventName, LicenseState>> = {
	active: {
		"subscription active": "active",
		"subscription canceled, in grace": "active",
		"subscription deleted, past grace": "lapsed",
		"payment failed": "active",
		"dispute opened": "revoked",
		"full refund": "revoked",
		"partial refund": "review",
		"dispute won": "active",
	},
	lapsed: {
		"subscription active": "active",
		"subscription canceled, in grace": "active",
		"subscription deleted, past grace": "lapsed",
		"payment failed": "lapsed",
		"dispute opened": "revoked",
		"full refund": "revoked",
		"partial refund": "review",
		"dispute won": "active",
	},
	revoked: {
		"subscription active": "revoked",
		"subscription canceled, in grace": "revoked",
		"subscription deleted, past grace": "revoked",
		"payment failed": "revoked",
		"dispute opened": "revoked",
		"full refund": "revoked",
		"partial refund": "revoked",
		"dispute won": "active",
	},
	review: {
		"subscription active": "review",
		"subscription canceled, in grace": "review",
		"subscription deleted, past grace": "review",
		"payment failed": "review",
		"dispute opened": "revoked",
		"full refund": "revoked",
		"partial refund": "review",
		"dispute won": "active",
	},
}

const pairs = LICENSE_STATES.flatMap((state) =>
	(Object.keys(LICENSE_EVENTS) as LicenseEventName[]).map((name) => [state, name] as const)
)

describe("licenseMachine", () => {
	it.each(pairs)("from %s on %s", (state, name) => {
		const step = licenseMachine.transition(state, LICENSE_EVENTS[name])

		expect(step.next).toBe(LICENSE_TABLE[state][name])
		expect(LICENSE_STATES).toContain(step.next)
		expect(step.effects).toEqual([])
	})

	it("records the payment state each payment event implies", () => {
		expect(licenseMachine.transition("active", LICENSE_EVENTS["payment failed"]).record).toEqual({
			paymentState: PaymentState.PastDue,
		})

		expect(licenseMachine.transition("review", LICENSE_EVENTS["dispute opened"]).record).toEqual({
			paymentState: PaymentState.Disputed,
		})

		expect(licenseMachine.transition("revoked", LICENSE_EVENTS["full refund"]).record).toEqual({
			paymentState: PaymentState.Refunded,
		})
	})

	it("leaves a revoked license's payment state on a partial refund, so a dispute it records stays readable", () => {
		const step = licenseMachine.transition("revoked", LICENSE_EVENTS["partial refund"])

		expect(isNoopStep("revoked", step)).toBe(true)
	})

	it("records the subscription status on every subscription event", () => {
		expect(licenseMachine.transition("revoked", LICENSE_EVENTS["subscription canceled, in grace"]).record).toEqual({
			subscriptionState: "canceled",
		})
	})
})

describe("declarationMachine", () => {
	it.each(LICENSE_STATES.flatMap((from) => LICENSE_STATES.map((to) => [from, to] as const)))(
		"moves from %s to %s on the operator's word",
		(from, to) => {
			expect(declarationMachine.transition(from, { kind: "operator-set", to }).next).toBe(to)
		}
	)
})

const EMAIL_EVENTS = {
	sent: { kind: "sent", messageID: "msg_1" },
	failed: { kind: "failed" },
} as const satisfies Record<string, EmailEvent>

const EMAIL_TABLE: Record<EmailState, Record<keyof typeof EMAIL_EVENTS, EmailState>> = {
	pending: { sent: "sent", failed: "failed" },
	failed: { sent: "sent", failed: "failed" },
	sent: { sent: "sent", failed: "sent" },
}

describe("emailMachine", () => {
	it.each(
		EMAIL_STATES.flatMap((state) =>
			(Object.keys(EMAIL_EVENTS) as Array<keyof typeof EMAIL_EVENTS>).map((name) => [state, name] as const)
		)
	)("from %s on %s", (state, name) => {
		expect(emailMachine.transition(state, EMAIL_EVENTS[name]).next).toBe(EMAIL_TABLE[state][name])
	})

	it("records the provider's message id with an accepted send", () => {
		expect(emailMachine.transition("failed", EMAIL_EVENTS.sent).record).toEqual({ messageID: "msg_1" })
	})

	it("makes no write for a send outcome after the email was sent", () => {
		expect(isNoopStep("sent", emailMachine.transition("sent", EMAIL_EVENTS.failed))).toBe(true)
	})
})
