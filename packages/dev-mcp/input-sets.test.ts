/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { resolveInputSet } from "./input-sets.ts"

describe("resolveInputSet — board", () => {
	it("defaults to the whole board and reports its live corpus hash", async () => {
		const set = await resolveInputSet({ kind: "board" })

		expect(set.selection).toBe("full")
		expect(set.n).toBeGreaterThan(500)
		expect(set.populationN).toBeUndefined()
		// Recomputed per resolve, never cached — a cached stamp verdict is the 2026-08-06 failure with extra steps.
		expect(set.corpusHash).toMatch(/^[0-9a-f]{64}$/)
	})

	it("reports what a slice EXCLUDED, not only what it kept", async () => {
		const set = await resolveInputSet({ kind: "board", country: "GB" })

		expect(set.selection).toBe("slice")
		expect(set.n).toBeGreaterThan(0)
		expect(set.populationN).toBeGreaterThan(set.n)
		expect(set.notCovered.some((line) => line.startsWith("countries excluded:"))).toBe(true)
	})

	it("carries a truth census, so a set with no coordinate truth says so before the run", async () => {
		const set = await resolveInputSet({ kind: "board" })
		const { components, coordinates, tier, none } = set.hasTruth

		expect(components + coordinates + tier + none).toBeGreaterThan(0)
	})
})

describe("resolveInputSet — literal", () => {
	it("requires a reason, because a hand-picked panel is a claim", async () => {
		await expect(resolveInputSet({ kind: "literal", inputs: ["Paris"], why: "" })).rejects.toThrow(/requires `why`/)
	})

	it("echoes the reason so it travels with every number the set produces", async () => {
		const set = await resolveInputSet({ kind: "literal", inputs: ["Paris", "Lyon"], why: "two FR controls" })

		expect(set.why).toBe("two FR controls")
		expect(set.selection).toBe("hand-picked")
	})

	it("reports that hand-picked inputs carry no truth and so cannot be graded", async () => {
		const set = await resolveInputSet({ kind: "literal", inputs: ["Paris"], why: "control" })

		expect(set.hasTruth.none).toBe(1)
		expect(set.notes.join(" ")).toContain("observed but not graded")
	})

	it("rejects an empty set rather than measuring nothing", async () => {
		await expect(resolveInputSet({ kind: "literal", inputs: [], why: "x" })).rejects.toThrow(/at least one input/)
	})
})
