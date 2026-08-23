/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A hand-picked input set may carry its own truth point — the authoring loop for a new board row.
 *
 *   The point of the feature is that a row can be MEASURED before its case file is written. So the tests that matter
 *   are: the truth reaches the resolved row, the graded fraction is reported against its own denominator, and a mixed
 *   set does not let an ungraded row read as a graded one.
 */

import { resolveInputSet } from "@mailwoman/dev-mcp/input-sets"
import { describe, expect, it } from "vitest"

const WHY = "resolved from the operator's own map links, so the pins are cited rather than invented"

describe("a literal input set carrying truth", () => {
	it("threads lat/lon onto the resolved row", async () => {
		const set = await resolveInputSet({
			kind: "literal",
			why: WHY,
			inputs: [{ input: "Queen Street, Bristol", lat: 51.449749, lon: -2.584173 }],
		})

		expect(set.inputs[0]).toMatchObject({ input: "Queen Street, Bristol", truthLat: 51.449749, truthLon: -2.584173 })
		expect(set.hasTruth).toMatchObject({ coordinates: 1, any: 1, none: 0 })
	})

	it("carries a per-row tolerance and truth type when given", async () => {
		const set = await resolveInputSet({
			kind: "literal",
			why: WHY,
			inputs: [{ input: "x", lat: 1, lon: 2, tolerance_m: 150, truth_type: "rooftop" }],
		})

		expect(set.inputs[0]).toMatchObject({ toleranceM: 150, truthType: "rooftop" })
	})

	it("still accepts bare strings, and says they cannot be graded", async () => {
		const set = await resolveInputSet({ kind: "literal", why: WHY, inputs: ["Queen Street, Bristol"] })

		expect(set.inputs[0]?.truthLat).toBeUndefined()
		expect(set.hasTruth).toMatchObject({ coordinates: 0, none: 1 })
		expect(set.notes.join(" ")).toMatch(/observed but not graded/)
	})

	it("reports a MIXED set against its own denominator, not against n", async () => {
		// The failure this guards: reading "1 of 2 resolved" as a rate over the graded rows when only one row
		// has truth at all. The note has to name both numbers.
		const set = await resolveInputSet({
			kind: "literal",
			why: WHY,
			inputs: ["no truth here", { input: "Queen Street, Bristol", lat: 51.449749, lon: -2.584173 }],
		})

		expect(set.hasTruth).toMatchObject({ coordinates: 1, any: 1, none: 1 })
		expect(set.notes.join(" ")).toMatch(/1 of 2 rows carry a truth coordinate/)
	})

	it("keys the digest on the TRUTH as well as the input, so two pins cannot collide on one setID", async () => {
		// Same string, different asserted point — a different measurement, and it must not read as a re-run.
		const a = await resolveInputSet({
			kind: "literal",
			why: WHY,
			inputs: [{ input: "Bristol", lat: 51.45, lon: -2.58 }],
		})

		const b = await resolveInputSet({
			kind: "literal",
			why: WHY,
			inputs: [{ input: "Bristol", lat: 41.68, lon: -72.94 }],
		})

		expect(a.setID).not.toBe(b.setID)
		expect(a.sha256).not.toBe(b.sha256)
	})
})
