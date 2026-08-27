/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit cover for the capture-recapture instrument. Everything here runs over synthetic points — the
 *   estimator's job is to be checkable without an extract in the loop.
 */

import { describe, expect, it } from "vitest"

import {
	chapmanEstimate,
	completenessAcrossProtocols,
	evaluatePair,
	MATCH_PROTOCOL_GRID,
	matchInventories,
	type CaptureRow,
	type MatchProtocol,
} from "#gazetteer-pipeline/poi/capture-recapture"

const PRIMARY = MATCH_PROTOCOL_GRID.find((p) => p.label === "primary")!

/**
 * ~1.11 m of latitude per 1e-5 degrees — enough to place two rows a known distance apart.
 */
function at(latitude: number, longitude: number, name: string | null): CaptureRow {
	return { latitude, longitude, name }
}

describe("chapmanEstimate", () => {
	it("matches the closed form", () => {
		// (10+1)(20+1)/(5+1) - 1 = 38.5 - 1 = 37.5
		expect(chapmanEstimate(10, 20, 5).population).toBeCloseTo(37.5, 6)
	})

	it("is defined at zero overlap, where plain Lincoln-Petersen is not", () => {
		const estimate = chapmanEstimate(10, 20, 0)

		expect(Number.isFinite(estimate.population)).toBe(true)
		expect(estimate.population).toBeCloseTo(230, 6)
	})

	it("collapses to the inventory size when the two agree completely", () => {
		const estimate = chapmanEstimate(40, 40, 40)

		expect(estimate.population).toBeCloseTo(40, 6)
		expect(estimate.standardError).toBe(0)
	})

	it("places the population interval around the point estimate", () => {
		const estimate = chapmanEstimate(100, 120, 60)

		expect(estimate.lower).toBeLessThan(estimate.population)
		expect(estimate.upper).toBeGreaterThan(estimate.population)
	})

	it("refuses an overlap larger than an inventory", () => {
		expect(() => chapmanEstimate(10, 20, 11)).toThrow(/exceeds an inventory size/)
	})

	it("refuses a negative or fractional count", () => {
		expect(() => chapmanEstimate(-1, 20, 0)).toThrow(/non-negative integers/)
		expect(() => chapmanEstimate(10.5, 20, 0)).toThrow(/non-negative integers/)
	})
})

describe("evaluatePair", () => {
	it("accepts a co-located pair whose names agree", () => {
		const result = evaluatePair(
			at(48.85, 2.35, "Pharmacie de la Gare"),
			at(48.85, 2.35, "PHARMACIE DE LA GARE"),
			PRIMARY
		)

		expect(result.accepted).toBe(true)
		expect(result.similarity).toBeGreaterThan(0.99)
	})

	it("folds diacritics before comparing", () => {
		const result = evaluatePair(
			at(48.85, 2.35, "Pharmacie de l'Église"),
			at(48.85, 2.35, "Pharmacie de l Eglise"),
			PRIMARY
		)

		expect(result.accepted).toBe(true)
	})

	it("refuses a co-located pair whose names disagree", () => {
		const result = evaluatePair(at(48.85, 2.35, "Pharmacie du Nord"), at(48.85, 2.35, "Boulangerie Poilâne"), PRIMARY)

		expect(result.accepted).toBe(false)
	})

	it("accepts an unnamed pair on position alone, but only inside the unnamed band", () => {
		expect(evaluatePair(at(48.85, 2.35, null), at(48.85, 2.35, "Pharmacie X"), PRIMARY).accepted).toBe(true)
		// ~0.0009 degrees of latitude is ~100 m, past the 25 m unnamed band.
		expect(evaluatePair(at(48.85, 2.35, null), at(48.8509, 2.35, "Pharmacie X"), PRIMARY).accepted).toBe(false)
	})

	it("skips the comparator past the widest band", () => {
		const result = evaluatePair(at(48.85, 2.35, "Pharmacie X"), at(48.95, 2.35, "Pharmacie X"), PRIMARY)

		expect(result.accepted).toBe(false)
		expect(result.similarity).toBe(0)
		expect(result.metres).toBeGreaterThan(1000)
	})
})

describe("matchInventories", () => {
	it("assigns one-to-one — a crowd of duplicates cannot answer for one row twice", () => {
		const first = [at(48.85, 2.35, "Pharmacie Centrale")]

		const second = [
			at(48.85, 2.35, "Pharmacie Centrale"),
			at(48.85001, 2.35, "Pharmacie Centrale"),
			at(48.85002, 2.35, "Pharmacie Centrale"),
		]

		expect(matchInventories(first, second, PRIMARY)).toHaveLength(1)
	})

	it("takes the better candidate when two compete for one row", () => {
		const first = [at(48.85, 2.35, "Pharmacie Centrale")]
		const second = [at(48.85, 2.35, "Pharmacie du Marche"), at(48.85001, 2.35, "Pharmacie Centrale")]
		const [pair] = matchInventories(first, second, PRIMARY)

		expect(pair?.second).toBe(1)
	})

	it("matches nothing between disjoint inventories", () => {
		const first = [at(48.85, 2.35, "Pharmacie Centrale")]
		const second = [at(49.5, 3.1, "Pharmacie Centrale")]

		expect(matchInventories(first, second, PRIMARY)).toHaveLength(0)
	})
})

describe("completenessAcrossProtocols", () => {
	/**
	 * Two inventories that agree on the first `overlap` rows and diverge after, spaced far enough apart that no
	 * unintended pair falls inside any band.
	 */
	function inventories(firstSize: number, secondSize: number, overlap: number) {
		const shared = Array.from({ length: overlap }, (_, i) => at(48.5 + i * 0.01, 2, `Pharmacie ${i}`))

		const first = [
			...shared,
			...Array.from({ length: firstSize - overlap }, (_, i) => at(48.5 + (overlap + i) * 0.01, 2.5, `Alpha ${i}`)),
		]

		const second = [
			...shared,
			...Array.from({ length: secondSize - overlap }, (_, i) => at(48.5 + (overlap + i) * 0.01, 3, `Beta ${i}`)),
		]

		return { first, second }
	}

	it("records the weakest lower bound the grid supports", () => {
		const { first, second } = inventories(30, 40, 20)
		const result = completenessAcrossProtocols(first, second)
		const bounds = result.perProtocol.map((p) => p.completenessLowerBound)

		expect(result.perProtocol).toHaveLength(MATCH_PROTOCOL_GRID.length)
		expect(result.recorded).toBe(Math.min(...bounds))
		expect(result.perProtocol.some((p) => p.protocol === result.recordedFrom)).toBe(true)
	})

	it("keeps the recorded value below the point estimate", () => {
		const { first, second } = inventories(30, 40, 20)
		const result = completenessAcrossProtocols(first, second)

		for (const protocol of result.perProtocol) {
			expect(protocol.completenessLowerBound).toBeLessThanOrEqual(protocol.completeness)
		}
	})

	it("never records a completeness above 1", () => {
		const { first, second } = inventories(20, 20, 20)
		const result = completenessAcrossProtocols(first, second)

		expect(result.recorded).toBeLessThanOrEqual(1)
	})

	it("reads a reference that agrees with nothing as no completeness at all", () => {
		const first = [at(48.85, 2.35, "Pharmacie Centrale")]
		const second = [at(49.5, 3.1, "Pharmacie du Nord")]
		const result = completenessAcrossProtocols(first, second)

		expect(result.recorded).toBeLessThan(0.6)
	})

	it("refuses an empty protocol grid rather than defaulting to one", () => {
		const grid: MatchProtocol[] = []

		expect(() => completenessAcrossProtocols([], [], grid)).toThrow(/protocol grid is empty/)
	})
})
