/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The capability-gap report exists so a backend that omits an optional method cannot disable a default-ON option
 *   silently. These cases pin the property that matters: a gap is DATA, not a log line that a caller may or may not
 *   have been watching for.
 */

import type { ResolverBackend } from "@mailwoman/core/resolver"
import { describeCapabilityGaps, formatCapabilityGaps } from "@mailwoman/resolver/backend-capabilities"
import { describe, expect, it } from "vitest"

/**
 * The minimum a backend must implement. A backend shaped like this is VALID — every method the gap report names is
 * optional on the contract — which is exactly why the absence needs reporting rather than rejecting.
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
		// Every gap reported must be one a caller did not choose — that is the whole reason it is worth reporting.
		expect(gaps.every((g) => g.defaultOn)).toBe(true)
		expect(gaps.every((g) => g.gates === "hierarchyCompletion")).toBe(true)
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
		// Both gaps share one line — an operator reads it or skips it once, not once per capability.
		expect(line).toContain("ancestors()")
		expect(line).toContain("coincidentLocalitiesFor()")
		expect(line).not.toContain("\n")
	})
})
