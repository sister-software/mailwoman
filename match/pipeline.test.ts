/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Capstone: the whole matcher, block → score → cluster, on a tiny synthetic set. The point it
 *   proves is the thesis — two records with DIFFERENT address strings but the same location and
 *   name resolve to one entity, because blocking is geographic, not textual.
 */

import { describe, expect, it } from "vitest"

import { type LatLon, block, geoCellKey } from "./blocking.js"
import { cluster } from "./clustering.js"
import { type ComparisonLevel, type FellegiSunterModel, scorePair, similarityComparison } from "./fellegi-sunter.js"

type Clinic = { id: string; given: string; family: string; canonical: string; coord: LatLon }

const NAME_LEVELS: ComparisonLevel[] = [
	{ label: "exact", minSimilarity: 1.0, m: 0.9, u: 0.05 },
	{ label: "different", minSimilarity: 0, m: 0.1, u: 0.95 },
]

const model: FellegiSunterModel<Clinic> = {
	lambda: 0.01,
	comparisons: [
		similarityComparison({ name: "given", extract: (r) => r.given, levels: NAME_LEVELS }),
		similarityComparison({ name: "family", extract: (r) => r.family, levels: NAME_LEVELS }),
	],
}

describe("block → score → cluster", () => {
	it("links two records at the same place despite different address strings, and isolates a third", () => {
		const records: Clinic[] = [
			// Same person/place — note the address STRINGS differ; only the location agrees.
			{
				id: "1",
				given: "Robert",
				family: "Smith",
				canonical: "123 main st",
				coord: { latitude: 45.5152, longitude: -122.6784 },
			},
			{
				id: "2",
				given: "Robert",
				family: "Smith",
				canonical: "123 main street apt 2",
				coord: { latitude: 45.5153, longitude: -122.6785 },
			},
			// A different entity, far away.
			{
				id: "3",
				given: "Maria",
				family: "Garcia",
				canonical: "50 elm ave",
				coord: { latitude: 47.6, longitude: -122.33 },
			},
		]

		// Block on geography — not on the (differing) address text.
		const { pairs } = block(
			records,
			geoCellKey((r) => r.coord)
		)
		// Score each candidate pair.
		const links = pairs.map(([a, b]) => ({ a, b, weight: scorePair(model, a, b).weight }))
		// Resolve into entities.
		const clusters = cluster(records, links, { threshold: 0 })

		const shape = clusters
			.map((g) =>
				g
					.map((r) => r.id)
					.sort()
					.join("")
			)
			.sort()
		expect(shape).toEqual(["12", "3"])
	})
})
