/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the retry policy — `Retry-After` parsing per RFC 9110 §10.2.3, and which failure
 *   classes are worth another attempt.
 */

import { AxiosError } from "axios"
import { describe, expect, it } from "vitest"

import {
	classifyAxiosFailure,
	DEFAULT_BASE_RETRY_DELAY_MS,
	DEFAULT_MAX_ATTEMPTS,
	isRetryableStatus,
	MAX_RETRY_AFTER_MS,
	parseRetryAfterMs,
	resolveRetryPolicy,
	retryDelayMs,
} from "./retry.ts"

describe("parseRetryAfterMs", () => {
	it("returns null only when the header is absent", () => {
		expect(parseRetryAfterMs(undefined)).toBeNull()
		expect(parseRetryAfterMs(null)).toBeNull()
		expect(parseRetryAfterMs("")).toBeNull()
	})

	it("parses the numeric delay-seconds form", () => {
		expect(parseRetryAfterMs("45")).toBe(45_000)
		expect(parseRetryAfterMs("  45  ")).toBe(45_000)
		expect(parseRetryAfterMs("0")).toBe(0)
	})

	it("clamps an excessive delay-seconds value to the ceiling", () => {
		expect(parseRetryAfterMs("999999")).toBe(MAX_RETRY_AFTER_MS)
	})

	it("parses the HTTP-date form, not just delay-seconds", () => {
		// m2: a numeric-only parse fell back to the SHORT exponential default on an HTTP-date — the other
		// form RFC 9110 allows — so a 429 asking for 45 seconds retried in half a second.
		const retryAt = new Date(Date.now() + 45_000)
		const parsed = parseRetryAfterMs(retryAt.toUTCString())

		expect(parsed).toBeGreaterThan(40_000)
		expect(parsed).toBeLessThanOrEqual(45_000)
	})

	it("floors an HTTP-date already in the past at zero", () => {
		expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0)
	})

	it("falls back to the LONG ceiling when the header is present but unparseable", () => {
		// The server is still asking us to back off; guessing short risks hammering it.
		expect(parseRetryAfterMs("not-a-valid-value")).toBe(MAX_RETRY_AFTER_MS)
		expect(parseRetryAfterMs("Tue, 99 Xyz 2026 99:99:99 GMT")).toBe(MAX_RETRY_AFTER_MS)
	})

	// RFC 9110's `delay-seconds` is `1*DIGIT` only — no hex, no sign, no decimal point. `Number()` is
	// laxer than the grammar (`Number("0x10") === 16`, `Number("1.5") === 1.5`), so a naive `Number()`
	// parse would silently honor either as a plausible-looking wait instead of falling back long.
	// `Date.parse("1.5")` ALSO returns a valid timestamp (~Jan 2001), which is why the HTTP-date branch
	// requires a literal `GMT` suffix before it trusts `Date.parse`.
	it.each([["0x10"], ["1.5"], ["-30"], ["+30"], ["1e3"]])(
		"rejects %s as delay-seconds, falling back to the long ceiling",
		(value) => {
			expect(parseRetryAfterMs(value)).toBe(MAX_RETRY_AFTER_MS)
		}
	)
})

describe("isRetryableStatus", () => {
	it.each([[408], [429], [500], [502], [503], [504], [599]])("treats %i as retryable", (status) => {
		expect(isRetryableStatus(status)).toBe(true)
	})

	it.each([[200], [301], [400], [401], [404], [410], [418], [422], [600]])("treats %i as terminal", (status) => {
		expect(isRetryableStatus(status)).toBe(false)
	})

	it("NEVER treats a 403 as retryable", () => {
		// A 403 means the request failed to identify itself. Retrying it cannot succeed and burns the
		// rate budget doing so.
		expect(isRetryableStatus(403)).toBe(false)
	})
})

describe("classifyAxiosFailure", () => {
	function axiosErrorWithResponse(status: number, headers: Record<string, string> = {}): AxiosError {
		return new AxiosError("failed", AxiosError.ERR_BAD_RESPONSE, undefined, undefined, {
			status,
			statusText: "",
			headers: headers as never,
			config: {} as never,
			data: undefined,
		})
	}

	it("marks a transport failure with no response as retryable", () => {
		const error = new AxiosError("socket hang up", AxiosError.ERR_NETWORK)

		expect(classifyAxiosFailure(error)).toEqual({ retryable: true, retryAfterMs: null })
	})

	it("marks a caller-initiated cancel as terminal", () => {
		const error = new AxiosError("canceled", AxiosError.ERR_CANCELED)

		expect(classifyAxiosFailure(error).retryable).toBe(false)
	})

	it("marks an axios timeout as retryable — it is a network-class failure, not a cancel", () => {
		expect(classifyAxiosFailure(new AxiosError("timeout", "ECONNABORTED")).retryable).toBe(true)
		expect(classifyAxiosFailure(new AxiosError("timeout", "ETIMEDOUT")).retryable).toBe(true)
	})

	it("reads Retry-After off the response when present", () => {
		expect(classifyAxiosFailure(axiosErrorWithResponse(429, { "retry-after": "30" }))).toEqual({
			retryable: true,
			retryAfterMs: 30_000,
		})
	})

	it("classifies a 403 as terminal even when it carries a Retry-After", () => {
		expect(classifyAxiosFailure(axiosErrorWithResponse(403, { "retry-after": "5" })).retryable).toBe(false)
	})

	it("returns a terminal directive for a non-Axios error", () => {
		expect(classifyAxiosFailure(new Error("nope"))).toEqual({ retryable: false, retryAfterMs: null })
	})
})

describe("resolveRetryPolicy / retryDelayMs", () => {
	it("resolves an absent option to exactly one attempt — retry is opt-in", () => {
		expect(resolveRetryPolicy(undefined).maxAttempts).toBe(1)
		expect(resolveRetryPolicy(false).maxAttempts).toBe(1)
	})

	it("resolves `true` to the documented defaults", () => {
		expect(resolveRetryPolicy(true)).toEqual({
			maxAttempts: DEFAULT_MAX_ATTEMPTS,
			baseDelayMs: DEFAULT_BASE_RETRY_DELAY_MS,
		})
	})

	it("never resolves below one attempt", () => {
		expect(resolveRetryPolicy({ maxAttempts: 0 }).maxAttempts).toBe(1)
		expect(resolveRetryPolicy({ maxAttempts: -3 }).maxAttempts).toBe(1)
	})

	it("doubles the base delay per attempt, and lets Retry-After override it", () => {
		const policy = resolveRetryPolicy({ maxAttempts: 4, baseDelayMs: 500 })
		const noHeader = { retryable: true, retryAfterMs: null }

		expect(retryDelayMs(1, noHeader, policy)).toBe(500)
		expect(retryDelayMs(2, noHeader, policy)).toBe(1000)
		expect(retryDelayMs(3, noHeader, policy)).toBe(2000)

		expect(retryDelayMs(1, { retryable: true, retryAfterMs: 7000 }, policy)).toBe(7000)
	})
})
