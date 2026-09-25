/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests `Retry-After` parsing (RFC 9110 §10.2.3) and the classification of retryable failures.
 */

import {
	classifyAxiosFailure,
	DEFAULT_BASE_RETRY_DELAY_MS,
	DEFAULT_MAX_ATTEMPTS,
	isRetryableStatus,
	MAX_RETRY_AFTER_MS,
	parseRetryAfterMs,
	resolveRetryPolicy,
	retryDelayMs,
} from "@mailwoman/core/api/retry"
import { AxiosError, type InternalAxiosRequestConfig } from "axios"
import { describe, expect, it } from "vitest"

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
		const retryAt = new Date(Date.now() + 45_000)
		const parsed = parseRetryAfterMs(retryAt.toUTCString())

		expect(parsed).toBeGreaterThan(40_000)
		expect(parsed).toBeLessThanOrEqual(45_000)
	})

	it("floors an HTTP-date already in the past at zero", () => {
		expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0)
	})

	it("falls back to the LONG ceiling when the header is present but unparseable", () => {
		expect(parseRetryAfterMs("not-a-valid-value")).toBe(MAX_RETRY_AFTER_MS)
		expect(parseRetryAfterMs("Tue, 99 Xyz 2026 99:99:99 GMT")).toBe(MAX_RETRY_AFTER_MS)
	})

	// The delay-seconds form accepts only plain digits.
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
		// Retrying cannot fix a rejected credential.
		expect(isRetryableStatus(403)).toBe(false)
	})
})

describe("classifyAxiosFailure", () => {
	function axiosErrorWithResponse(status: number, headers: Record<string, string> = {}): AxiosError {
		return new AxiosError("failed", AxiosError.ERR_BAD_RESPONSE, undefined, undefined, {
			status,
			statusText: "",
			headers,
			config: {} as InternalAxiosRequestConfig,
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
