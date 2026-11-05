/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The capability-gap report exists so a backend that omits an optional method cannot disable a default-on option
 *   silently. These cases pin the property that matters: a gap is data rather than a log line that a caller may or may not
 *   have been watching for.
 */

import type { ResolverBackend } from "@mailwoman/core/resolver"
import { afterEach, describe, expect, it, vi } from "vitest"

import { describeCapabilityGaps, formatCapabilityGaps } from "#backend-capabilities"
import { createWOFResolver } from "#resolve"

/**
 * The minimum a backend must implement.
 *
 * A backend shaped like this is valid.
 * Every method the gap report names is optional on the interface — which is exactly
 * why the absence needs reporting rather than rejecting.
 */
class MinimalBackend implements ResolverBackend {
	async findPlace() {
		return []
	}
}

class CompleteBackend implements ResolverBackend {
	async findPlace() {
		return []
	}
	ancestors() {
		return []
	}
	coincidentLocalitiesFor() {
		return []
	}
}

describe("describeCapabilityGaps", () => {
	it("names every default-ON option a minimal backend disables", () => {
		const gaps = describeCapabilityGaps(new MinimalBackend())

		expect(gaps.map((g) => g.capability).toSorted()).toEqual(["ancestors", "coincidentLocalitiesFor"])
		// Every gap reported must be one a caller did not choose.
		// A gap the caller chose by configuration is not reported.
		expect(gaps.every((g) => g.defaultOn)).toBe(true)
		expect(gaps.every((g) => g.option === "hierarchyCompletion")).toBe(true)
	})

	it("reports nothing for a backend that implements them", () => {
		expect(describeCapabilityGaps(new CompleteBackend())).toEqual([])
	})

	it("identifies the backend so a log line says which artifact is loaded", () => {
		const gaps = describeCapabilityGaps(new MinimalBackend())
		const line = formatCapabilityGaps(gaps)

		expect(gaps[0]?.backend).toBe("MinimalBackend")
		expect(line).toContain("MinimalBackend")
		expect(line).toContain("default-ON")
		// Both gaps share one line.
		// An operator reads it or skips it once rather than once per capability.
		expect(line).toContain("ancestors()")
		expect(line).toContain("coincidentLocalitiesFor()")
		expect(line).not.toContain("\n")
	})
})

describe("the capability-gap report", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	// The report is deduplicated per backend name for the whole process, so each case declares its own class.
	it("is written when a resolveTree call leaves the dependent option on", async () => {
		class GapReportedBackend extends MinimalBackend {}
		const errors = vi.spyOn(console, "error").mockImplementation(() => {})
		const resolver = createWOFResolver(new GapReportedBackend())

		expect(errors).not.toHaveBeenCalled()

		await resolver.resolveTree({ raw: "", roots: [] })

		expect(errors).toHaveBeenCalledTimes(1)
		expect(String(errors.mock.calls[0]?.[0])).toContain("GapReportedBackend lacks ancestors()")
	})

	it("is not written when the caller turns the dependent option off, and the gaps stay readable as data", async () => {
		class GapDeclinedBackend extends MinimalBackend {}
		const errors = vi.spyOn(console, "error").mockImplementation(() => {})
		const resolver = createWOFResolver(new GapDeclinedBackend())

		await resolver.resolveTree({ raw: "", roots: [] }, { hierarchyCompletion: false })

		expect(errors).not.toHaveBeenCalled()

		expect(resolver.capabilityGaps?.map((gap) => gap.capability).toSorted()).toEqual([
			"ancestors",
			"coincidentLocalitiesFor",
		])
	})
})
