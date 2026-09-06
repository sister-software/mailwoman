/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The claim page's reducer: the phases a buyer can land in, and which events end the polling. The clock is the
 *   events', so the deadline is asserted by arithmetic rather than by waiting.
 */

import { CLAIM_DEADLINE_MS, claimURL, initialClaimState, nextClaimState } from "@mailwoman/docs/license/claim"
import { describe, expect, it } from "vitest"

const T0 = 1_000_000

const issued = {
	status: "issued" as const,
	token: "mwl1.a.b",
	lid: `lic_${"a".repeat(22)}`,
	licensee: "Example Ltd",
	issued: "2026-10-01",
	expires: "2026-11-15",
	refresh_secret: "s".repeat(43),
}

describe("the claim page's state", () => {
	it("stays polling on pending until the deadline, then says the email is coming", () => {
		let state = initialClaimState()

		state = nextClaimState(state, { kind: "response", response: { status: "pending" }, now: T0 })
		expect(state).toEqual({ phase: "polling", attempts: 1, startedAt: T0 })

		state = nextClaimState(state, { kind: "response", response: { status: "pending" }, now: T0 + 3000 })
		expect(state).toMatchObject({ phase: "polling", attempts: 2, startedAt: T0 })

		state = nextClaimState(state, {
			kind: "response",
			response: { status: "pending" },
			now: T0 + CLAIM_DEADLINE_MS + 1,
		})

		expect(state).toEqual({ phase: "waiting_too_long", attempts: 3 })
	})

	it("issued ends polling with the claim; revoked and the worker's 404 end it with their word", () => {
		expect(nextClaimState(initialClaimState(), { kind: "response", response: issued, now: T0 })).toEqual({
			phase: "issued",
			claim: issued,
		})

		expect(nextClaimState(initialClaimState(), { kind: "response", response: { status: "revoked" }, now: T0 })).toEqual(
			{ phase: "revoked" }
		)

		expect(nextClaimState(initialClaimState(), { kind: "http", status: 404, now: T0 })).toEqual({
			phase: "not_found",
		})
	})

	it("a network error or a 5xx keeps polling until the deadline, then reads unreachable, a different word from a long wait", () => {
		let state = initialClaimState()

		state = nextClaimState(state, { kind: "error", now: T0 })
		expect(state).toEqual({ phase: "polling", attempts: 1, startedAt: T0 })

		state = nextClaimState(state, { kind: "http", status: 503, now: T0 + CLAIM_DEADLINE_MS + 1 })
		expect(state).toEqual({ phase: "unreachable", attempts: 2 })
	})

	it("a terminal state ignores later events", () => {
		const done = { phase: "revoked" as const }

		expect(nextClaimState(done, { kind: "response", response: issued, now: T0 })).toEqual(done)
	})

	it("the claim URL names the worker's route with the session id escaped", () => {
		expect(claimURL("cs_test_a1")).toBe("https://license.mailwoman.ai/v1/checkout-sessions/cs_test_a1/license")
		expect(claimURL("a/b")).toBe("https://license.mailwoman.ai/v1/checkout-sessions/a%2Fb/license")
	})
})
