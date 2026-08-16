/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import { resolveInputSet } from "./input-sets.ts"

/**
 * The board and parity corpora are COMMITTED, so they grade everywhere. The panel and golden sets live under
 * `$MAILWOMAN_DATA_ROOT` and are absent in CI, so their suites are presence-gated the way `weights.test.ts` gates on
 * the dev model.
 *
 * A skipped suite is not a passing one: these assertions hold only on a machine carrying the artifacts, and CI's green
 * tick says nothing about them.
 */
const havePanel = existsSync(String(dataRootPath("pelias-rig", "panel", "panel-v2.jsonl")))
const haveGolden = existsSync(String(dataRootPath("eval", "golden", "v0.1.3", "dev", "us.jsonl")))

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

describe.skipIf(!havePanel)("resolveInputSet — panel", () => {
	it("resolves the pre-registered v2 panel with a coordinate on every row", async () => {
		const set = await resolveInputSet({ kind: "panel", version: "v2" })

		expect(set.n).toBe(420)
		expect(set.hasTruth.coordinates).toBe(420)
		expect(set.hasTruth.none).toBe(0)
	})

	it("carries truth_type per row rather than blending it away", async () => {
		// The benchmark plan's own rule: a headline "@1km lives or dies on truth_type". A caller that cannot see it
		// reports a number about its own row mix.
		const set = await resolveInputSet({ kind: "panel", version: "v2" })

		expect(set.inputs.some((row) => row.truthType === "rooftop")).toBe(true)
		expect(set.notes.join(" ")).toContain("truth_type")
	})

	it("reports what a truth_type slice excluded", async () => {
		const set = await resolveInputSet({ kind: "panel", version: "v2", truth_type: "rooftop" })

		expect(set.selection).toBe("slice")
		expect(set.populationN).toBe(420)
		expect(set.notCovered.join(" ")).toContain("truth types excluded")
	})
})

describe.skipIf(!haveGolden)("resolveInputSet — golden", () => {
	it("counts component expectations rather than reporting them as nothing", async () => {
		// First run of this resolver reported `none: 4255` on a 4,255-row set, because the census only knew how to read
		// a SeedCase and golden rows carry `components` instead.
		const set = await resolveInputSet({ kind: "golden" })

		expect(set.hasTruth.components).toBe(set.n)
		expect(set.hasTruth.none).toBe(0)
	})

	it("names the dev split as the tuning half", async () => {
		const set = await resolveInputSet({ kind: "golden", split: "dev" })

		expect(set.notes.join(" ")).toContain("TUNING half")
	})
})

describe("resolveInputSet — parity", () => {
	it("skips tombstones, matching the harness's own live count", async () => {
		// `parity-corpus.ts` filters `!dropped && expect` and prints "321 live fixtures (55 tombstones skipped)".
		// Resolving all 376 would feed fixtures a neural parser must not be graded against into the denominator.
		const set = await resolveInputSet({ kind: "parity" })

		expect(set.n).toBe(321)
		expect(set.notes.join(" ")).toContain("tombstones skipped")
	})

	it("reports zero coordinate truth, so a distance claim cannot be built on it", async () => {
		const set = await resolveInputSet({ kind: "parity" })

		expect(set.hasTruth.coordinates).toBe(0)
		expect(set.notes.join(" ")).toContain("NO coordinates")
	})
})

describe.skipIf(!haveGolden)("a corpus that cannot be read", () => {
	it("refuses rather than resolving to an empty set", async () => {
		// An empty set measures zero differences, which reads as "no effect" rather than "nothing ran".
		await expect(resolveInputSet({ kind: "golden", version: "v9.9.9-nonexistent" })).rejects.toThrow(
			/resolved no rows|not found/
		)
	})
})
