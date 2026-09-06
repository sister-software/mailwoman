/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The access-state rules as a decision table: each row is one observation and the state it decides, so a change to
 *   the precedence is a changed row here before it is a changed answer anywhere else.
 */

import { LicenseState } from "@mailwoman/license-worker/ledger/schema"
import {
	licenseStateAfterDispute,
	licenseStateAfterRefund,
	licenseStateAfterSubscription,
	publicLicenseStatus,
} from "@mailwoman/license-worker/policy"
import { describe, expect, it } from "vitest"

const WITHIN_GRACE = { graceUntil: "2026-11-15", today: "2026-11-10" }
const PAST_GRACE = { graceUntil: "2026-11-15", today: "2026-11-16" }
const NO_TOKEN = { today: "2026-11-10" }

describe("the license-state policy", () => {
	it.each([
		// current, subscription status, deleted, observation, expected
		["active", "active", false, WITHIN_GRACE, "active"],
		["active", "canceled", false, WITHIN_GRACE, "active"],
		["active", "canceled", false, PAST_GRACE, "lapsed"],
		["active", "unpaid", false, PAST_GRACE, "lapsed"],
		["active", "active", true, PAST_GRACE, "lapsed"],
		["active", "canceled", false, NO_TOKEN, "lapsed"],
		["lapsed", "active", false, PAST_GRACE, "active"],
		["revoked", "active", false, WITHIN_GRACE, "revoked"],
		["revoked", "canceled", false, PAST_GRACE, "revoked"],
		// A review outlives the token's date: the standing choice, and the one row an operator may want to change.
		["review", "canceled", false, PAST_GRACE, "review"],
		["review", "active", false, WITHIN_GRACE, "review"],
	] as const)(
		"%s license, subscription %s (deleted: %s), %o reads %s",
		(current, status, deleted, observation, expected) => {
			expect(licenseStateAfterSubscription(current, { status }, { ...observation, deleted })).toBe(expected)
		}
	)

	it("a won dispute hands the license back to its subscription by deciding from active again", () => {
		expect(licenseStateAfterSubscription(LicenseState.Active, { status: "active" }, WITHIN_GRACE)).toBe("active")
		expect(licenseStateAfterSubscription(LicenseState.Active, { status: "canceled" }, PAST_GRACE)).toBe("lapsed")
	})

	it("a full refund revokes, a partial refund is the operator's review, and a dispute revokes", () => {
		expect(licenseStateAfterRefund({ amount: 25_000, amount_refunded: 25_000 })).toBe("revoked")
		expect(licenseStateAfterRefund({ amount: 25_000, amount_refunded: 10_000 })).toBe("review")
		expect(licenseStateAfterDispute()).toBe("revoked")
	})

	it("the public word for review is active; every other state is its own word", () => {
		expect(publicLicenseStatus(LicenseState.Review)).toBe("active")
		expect(publicLicenseStatus(LicenseState.Active)).toBe("active")
		expect(publicLicenseStatus(LicenseState.Lapsed)).toBe("lapsed")
		expect(publicLicenseStatus(LicenseState.Revoked)).toBe("revoked")
	})
})
