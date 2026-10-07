/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the prominence-floor definition audit. Each case supplies a definition the runner cannot execute.
 *   The audit reports the reason for each refusal.
 *
 *   Band edges define the measurement. Two bands that overlap would count a row twice in per-band results.
 *   A row without a recorded population must stay unbucketed rather than count as a zero-population member.
 */

import { beforeAll, describe, expect, it } from "vitest"

import {
	auditProminenceDefinition,
	bandFor,
	loadProminenceDefinition,
	type ProminenceFloorDefinition,
} from "#tools/eval-harness/prominence-floor/definition"

let frozen: ProminenceFloorDefinition

beforeAll(async () => {
	frozen = await loadProminenceDefinition()
})

/**
 * The frozen definition with one clause replaced.
 *
 * Structured clone so a case cannot leak into the next.
 */
function withChange(change: (draft: ProminenceFloorDefinition) => void): ProminenceFloorDefinition {
	const draft = structuredClone(frozen)

	change(draft)

	return draft
}

describe("prominence-floor ruler (#2264)", () => {
	it("loads the frozen definition through its own refusal ladder with a clean audit", () => {
		expect(frozen.benchmarkID).toBe("prominence-floor-v1")
		expect(auditProminenceDefinition(frozen)).toEqual([])
	})

	it("refuses bands that overlap, because a row would be counted in two", () => {
		const problems = auditProminenceDefinition(
			withChange((draft) => {
				draft.populationBands[1]!.min = draft.populationBands[0]!.max
			})
		)

		expect(problems.some((problem) => problem.includes("overlap"))).toBe(true)
	})

	it("refuses an unbounded band that is not the last one", () => {
		const problems = auditProminenceDefinition(
			withChange((draft) => {
				draft.populationBands[0]!.max = 0
			})
		)

		expect(problems.some((problem) => problem.includes("unbounded but is not the last band"))).toBe(true)
	})

	it("refuses a band whose ceiling sits below its floor", () => {
		const problems = auditProminenceDefinition(
			withChange((draft) => {
				// Use the second band so the inverted ceiling is not 0.
				// Zero means unbounded, so another check would refuse that value first.
				draft.populationBands[1]!.max = draft.populationBands[1]!.min - 1
			})
		)

		expect(problems.some((problem) => problem.includes("ceiling sits below its floor"))).toBe(true)
	})

	it("refuses a band starting below 1, which would admit an uncounted population as a zero", () => {
		const problems = auditProminenceDefinition(
			withChange((draft) => {
				draft.populationBands[0]!.min = 0
			})
		)

		expect(problems.some((problem) => problem.includes("must start at 1 or above"))).toBe(true)
	})

	it("refuses a gap between bands, which would drop rows with nothing reporting it", () => {
		const problems = auditProminenceDefinition(
			withChange((draft) => {
				// One below the second band's floor.
				// Therefore, 999 itself falls in no band.
				draft.populationBands[0]!.max = draft.populationBands[0]!.max - 1
			})
		)

		expect(problems.some((problem) => problem.includes("in no band"))).toBe(true)
	})

	it("refuses a floor arm that pins nothing, and a default arm that pins something", () => {
		const unpinned = auditProminenceDefinition(
			withChange((draft) => {
				delete draft.arms.find((arm) => arm.id === "floor_2")!.resolveOpts
			})
		)

		expect(unpinned.some((problem) => problem.includes("pins no minWinningScore"))).toBe(true)

		const pinned = auditProminenceDefinition(
			withChange((draft) => {
				draft.arms.find((arm) => arm.id === "default")!.resolveOpts = { minWinningScore: 1 }
			})
		)

		expect(pinned.some((problem) => problem.includes("then it is not the default path"))).toBe(true)
	})

	it("refuses a sampling floor above its own target", () => {
		const problems = auditProminenceDefinition(
			withChange((draft) => {
				draft.sampling.minimumRowsPerStratum = draft.sampling.rowsPerStratum + 1
			})
		)

		expect(problems.some((problem) => problem.includes("cannot sit above the target"))).toBe(true)
	})

	it("refuses more than one stratum registering abstention as correct", () => {
		const problems = auditProminenceDefinition(
			withChange((draft) => {
				for (const stratum of draft.strata) {
					stratum.correctIsAbstention = true
				}
			})
		)

		expect(problems.some((problem) => problem.includes("strata register abstention as correct"))).toBe(true)
	})

	it("places a population in exactly one band, and an absent population in none", () => {
		const bands = frozen.populationBands

		expect(bandFor(bands, 1)?.id).toBe("pop_1_999")
		expect(bandFor(bands, 999)?.id).toBe("pop_1_999")
		expect(bandFor(bands, 1000)?.id).toBe("pop_1k_4999")
		expect(bandFor(bands, 49_999)?.id).toBe("pop_15k_49999")
		expect(bandFor(bands, 9_000_000)?.id).toBe("pop_50k_up")

		// An absent count and a zero count reach no band.
		// The smallest band starts at 1.
		expect(bandFor(bands, null)).toBeNull()
		expect(bandFor(bands, 0)).toBeNull()
	})

	it("registers a floor that rejects an entire band, which is the question it asks", () => {
		const floors = frozen.arms
			.map((arm) => arm.resolveOpts?.minWinningScore)
			.filter((floor): floor is number => floor !== undefined)

		expect(floors).toEqual([1, 2, 3, 4])

		// A floor of F admits population 10^F.
		// The registered set must reject at least one whole band.
		// Otherwise, every gold could clear every floor, repeating the same-data panel's
		// blind spot and leaving the rate uninterpretable. floor_4 admits 10,000.
		// The second band ends at 4,999, so floor_4 rejects both smallest bands.
		const highest = Math.max(...floors)

		const bandsRejectedOutright = frozen.populationBands.filter(
			(band) => band.max !== 0 && band.max < Math.pow(10, highest)
		)

		expect(bandsRejectedOutright.map((band) => band.id)).toEqual(["pop_1_999", "pop_1k_4999"])
	})
})
