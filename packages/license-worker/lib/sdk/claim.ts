/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The claim page's state, as a pure reducer over the worker's claim route, and the one fetch that feeds it. Only
 *   `polling` moves; every other phase is terminal. `pending` past the deadline is the page saying the email will arrive
 *   on its own; an unanswered worker past the deadline is `unreachable`, a different word, because a customer who sees
 *   it acts differently. The docs site is a browser bundle, so the request is a plain `fetch`: the worker's exact-origin
 *   CORS admits this site and answers `no-store`.
 */

import { LICENSE_WORKER_URL } from "#sdk/constants"

export type ClaimResponse =
	| { status: "pending" }
	| { status: "revoked" }
	| {
			status: "issued"
			token: string
			lid: string
			licensee: string
			issued: string
			expires: string
			refresh_secret?: string
	  }

export type IssuedClaim = Extract<ClaimResponse, { status: "issued" }>

export type ClaimState =
	| { phase: "polling"; attempts: number; startedAt?: number }
	| { phase: "issued"; claim: IssuedClaim }
	| { phase: "revoked" }
	| { phase: "not_found" }
	| { phase: "waiting_too_long"; attempts: number }
	| { phase: "unreachable"; attempts: number }

export type ClaimEvent =
	| { kind: "response"; response: ClaimResponse; now: number }
	| { kind: "http"; status: number; now: number }
	| { kind: "error"; now: number }

/**
 * The pause between polls: Stripe's webhook lands within seconds of the redirect, so three is short enough to feel live
 * and long enough to stay under the worker's per-address claim limit for the whole deadline.
 */
export const CLAIM_INTERVAL_MS = 3000

/**
 * How long the page keeps asking before it says the email will arrive on its own.
 */
export const CLAIM_DEADLINE_MS = 120_000

const HTTP_NOT_FOUND = 404

export function claimURL(sessionID: string): string {
	return `${LICENSE_WORKER_URL}/v1/checkout-sessions/${encodeURIComponent(sessionID)}/license`
}

/**
 * Polling, with no start time yet: the deadline counts from the first event, so a render is pure and the clock is the
 * events'.
 */
export function initialClaimState(): ClaimState {
	return { phase: "polling", attempts: 0 }
}

export function nextClaimState(state: ClaimState, event: ClaimEvent): ClaimState {
	if (state.phase !== "polling") {
		return state
	}

	const attempts = state.attempts + 1
	const startedAt = state.startedAt ?? event.now
	const overdue = event.now - startedAt > CLAIM_DEADLINE_MS
	const stillPolling: ClaimState = { phase: "polling", attempts, startedAt }

	if (event.kind === "response") {
		if (event.response.status === "issued") {
			return { phase: "issued", claim: event.response }
		}

		if (event.response.status === "revoked") {
			return { phase: "revoked" }
		}

		if (overdue) {
			return { phase: "waiting_too_long", attempts }
		}

		return stillPolling
	}

	if (event.kind === "http" && event.status === HTTP_NOT_FOUND) {
		return { phase: "not_found" }
	}

	if (overdue) {
		return { phase: "unreachable", attempts }
	}

	return stillPolling
}

/**
 * One poll. Never throws: every outcome is an event the reducer knows.
 */
export async function fetchClaim(sessionID: string, signal?: AbortSignal): Promise<ClaimEvent> {
	const now = Date.now()

	try {
		const response = await fetch(claimURL(sessionID), { headers: { accept: "application/json" }, signal })

		if (!response.ok) {
			return { kind: "http", status: response.status, now }
		}

		return { kind: "response", response: await response.json(), now }
	} catch {
		return { kind: "error", now }
	}
}
