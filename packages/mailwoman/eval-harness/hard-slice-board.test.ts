/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hard-slice board's own guards. Two things are worth a test here and nothing else is:
 *
 *   1. The COMMITTED board loads and validates — a board that silently dropped a malformed row would
 *        under-report its own size and the arm comparison would run on a set nobody declared.
 *   2. The all-or-nothing coordinate refinement actually refuses partials. That rule is the board's
 *        meaning-of-zero discipline, and a schema rule nobody tests is a comment.
 */

import { describe, expect, it } from "vitest"

import { HardSliceCaseSchema, loadHardSliceBoard } from "./hard-slice-board.ts"

const VALID = {
	id: "probe-row",
	input: "Moscow Idaho",
	locale: "en-us",
	country: "US",
	class: "comma_free",
	fstReach: "in",
	probeSurface: "Moscow",
	popBias: 0.3411,
	impBias: 0.5465,
	probeTag: "locality",
	source: "test",
	addedAt: "2026-08-06",
} as const

describe("hard-slice board schema", () => {
	it("accepts a row with no coordinate at all", () => {
		expect(HardSliceCaseSchema.safeParse(VALID).success).toBe(true)
	})

	it("accepts a complete coordinate triple", () => {
		const parsed = HardSliceCaseSchema.safeParse({
			...VALID,
			expectLat: 46.7306,
			expectLon: -116.999,
			expectToleranceM: 15_000,
		})

		expect(parsed.success).toBe(true)
	})

	it.each([
		["lat only", { expectLat: 46.7306 }],
		["lat + lon, no tolerance", { expectLat: 46.7306, expectLon: -116.999 }],
		["tolerance only", { expectToleranceM: 15_000 }],
		["lon + tolerance, no lat", { expectLon: -116.999, expectToleranceM: 15_000 }],
	])("refuses a partial coordinate (%s)", (_label, partial) => {
		expect(HardSliceCaseSchema.safeParse({ ...VALID, ...partial }).success).toBe(false)
	})

	it("refuses an unknown key rather than ignoring it", () => {
		// A typo'd `expectLon` that parsed as "coordinate not asserted" is the input-tail defect the
		// strict schema exists to make loud.
		expect(HardSliceCaseSchema.safeParse({ ...VALID, expectLng: -116.999 }).success).toBe(false)
	})
})

describe("hard-slice board fixture", () => {
	it("loads, validates, and is sorted by id", async () => {
		const board = await loadHardSliceBoard()

		expect(board.length).toBeGreaterThan(0)
		expect(board.map((c) => c.id)).toEqual(board.map((c) => c.id).toSorted((a, b) => a.localeCompare(b)))
	})

	it("declares a tolerance for every coordinate it asserts", async () => {
		const board = await loadHardSliceBoard()

		const partial = board.filter(
			(c) => [c.expectLat, c.expectLon, c.expectToleranceM].filter((v) => v !== undefined).length % 3 !== 0
		)

		expect(partial.map((c) => c.id)).toEqual([])
	})
})
