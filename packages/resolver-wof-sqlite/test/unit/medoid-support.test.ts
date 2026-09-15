/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The #920 medoid law under duplicate points. GeoNames postal coordinates are frequently COMPUTED — matched from
 *   place names and admin divisions, averaged from neighbours where the match fails — so rows sharing a coordinate to
 *   the digit carry one value, not N. The collapse must leave the scattered case untouched: those are the rows the law
 *   was measured on.
 */

import { medoidPoint, medoidWithSupport, type PostcodePoint } from "@mailwoman/resolver-wof-sqlite/geonames"
import { describe, expect, it } from "vitest"

describe("medoidWithSupport — duplicate rows are one point", () => {
	it("counts a degenerate group once, however many rows carry it", () => {
		// TH 10230: `Lat Phrao` and `Khanna Yao`, both Bangkok districts, both published at 14.3333 / 99.9167.
		const rows: PostcodePoint[] = [
			[14.3333, 99.9167],
			[14.3333, 99.9167],
		]

		expect(medoidWithSupport(rows)).toEqual({ point: [14.3333, 99.9167], rows: 2, distinctPoints: 1 })
	})

	it("reports rows and distinct points separately where they differ", () => {
		const rows: PostcodePoint[] = [
			[50, 14],
			[50, 14],
			[50.2, 14.4],
		]

		const support = medoidWithSupport(rows)

		expect(support.rows).toBe(3)
		expect(support.distinctPoints).toBe(2)
	})

	it("refuses an empty group rather than inventing a point", () => {
		expect(() => medoidWithSupport([])).toThrow(/no member points/)
	})
})

describe("medoidPoint", () => {
	it("returns a lone member exactly", () => {
		expect(medoidPoint([[60.17, 24.94]])).toEqual([60.17, 24.94])
	})

	it("stays on a member rather than the mean", () => {
		// The mean of these three is 50.1 / 14.2, which is no member.
		const members: PostcodePoint[] = [
			[50, 14],
			[50.1, 14.2],
			[50.2, 14.4],
		]

		expect(medoidPoint(members)).toEqual([50.1, 14.2])
	})

	it("does not let a repeated point drag the pick toward itself", () => {
		// Two rows at the western member and one at each of the others. Counting rows would put the mean at
		// 50.05 / 14.1 and elect the duplicate; counting distinct points keeps the true middle member.
		const members: PostcodePoint[] = [
			[50, 14],
			[50, 14],
			[50.1, 14.2],
			[50.2, 14.4],
		]

		expect(medoidPoint(members)).toEqual([50.1, 14.2])
	})

	it("breaks a tie on the earliest member, so a rebuild's ids are stable", () => {
		const members: PostcodePoint[] = [
			[10, 20],
			[12, 20],
		]

		expect(medoidPoint(members)).toEqual([10, 20])
	})
})
