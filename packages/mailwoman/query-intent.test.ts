/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `declaredAmbiguityMarker` — the resolve-time half of the §4 intent vocabulary.
 *
 *   The fixtures are the two places the ablation-expectation module says the number lives or dies:
 *   Springfield (0.05 across 144 distinct bearers — ambiguous) and Paris (1.9 once the coincident
 *   `locality`/`localadmin` twin is collapsed, 0.01 before). The Paris row is the important one,
 *   because a collapse that stops working makes this marker fire on every capital city and the
 *   correctness tests would all still pass.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { QueryKind } from "@mailwoman/core/pipeline"
import { describe, expect, test } from "vitest"

import { declaredAmbiguityMarker } from "./query-intent.ts"

interface PlaceFixture {
	name: string
	placetype?: string
	lat: number
	lon: number
	/**
	 * `-log10(population + 1)` negated — i.e. `log10(population + 1)`. Bigger = more populous, matching the resolver's
	 * `prominence` on the candidate backend.
	 */
	prominence: number
}

function treeOf(winner: PlaceFixture, alternatives: PlaceFixture[]): AddressTree {
	const node: AddressNode = {
		tag: "locality",
		value: winner.name,
		start: 0,
		end: winner.name.length,
		confidence: 0.9,
		children: [],
		lat: winner.lat,
		lon: winner.lon,
		placeID: "wof:1",
		metadata: {
			resolver_name: winner.name,
			resolver_country: "US",
			resolver_prominence: winner.prominence,
		},
		alternatives: alternatives.map((a, i) => ({
			id: i + 2,
			name: a.name,
			placetype: a.placetype ?? "locality",
			country: "US",
			lat: a.lat,
			lon: a.lon,
			prominence: a.prominence,
			score: a.prominence,
		})),
	}

	return { raw: winner.name, roots: [node] }
}

const BARE: QueryKind[] = ["locality_only", "bare_toponym", "vague"]

/**
 * The 144-bearer namesake class. log10 populations 5.10 / 5.05 → a 0.05 margin, an order of magnitude under the cut.
 */
const SPRINGFIELD = treeOf({ name: "Springfield", lat: 37.2153, lon: -93.2982, prominence: 5.1 }, [
	{ name: "Springfield", lat: 42.1015, lon: -72.5898, prominence: 5.05 },
	{ name: "Springfield", lat: 39.7817, lon: -89.6501, prominence: 5.02 },
])

describe("declaredAmbiguityMarker", () => {
	test("fires on a thin margin, and reports the measurement that tripped it", () => {
		const marker = declaredAmbiguityMarker({ kinds: BARE, tree: SPRINGFIELD, lat: 37.2153, lon: -93.2982 })

		expect(marker).not.toBeNull()
		expect(marker!.code).toBe("declared_ambiguity")
		expect(marker!.kind).toBe("bare_toponym")
		expect(marker!.mechanism).toBe("resolver:dominance_margin")
		expect(marker!.evidence?.["margin"]).toBeCloseTo(0.05, 4)
		expect(marker!.evidence?.["decisiveMarginLog10"]).toBe(0.5)
		expect(marker!.evidence?.["distinctPlaces"]).toBe(3)
		expect(marker!.evidence?.["runnerUp"]).toMatchObject({ name: "Springfield" })
	})

	test("stays silent on a decisive margin", () => {
		// Paris FR (2.1M) against Paris TX (25k): a 1.9 log10 margin, well clear of the cut.
		const tree = treeOf({ name: "Paris", lat: 48.8566, lon: 2.3522, prominence: 6.32 }, [
			{ name: "Paris", lat: 33.6609, lon: -95.5555, prominence: 4.4 },
		])

		expect(declaredAmbiguityMarker({ kinds: BARE, tree, lat: 48.8566, lon: 2.3522 })).toBeNull()
	})

	test("collapses the coincident WOF twin before measuring — the trap that would fire on every capital", () => {
		// Paris the `locality` and Paris the `localadmin`: same city, same population, ~0.3 km apart. A RAW top-2 margin
		// here is 0.01, which is under the cut; the 10 km collapse is what makes the number mean anything. Without it
		// this assertion returns a marker and every major city in the world reads as ambiguous.
		const tree = treeOf({ name: "Paris", lat: 48.8566, lon: 2.3522, prominence: 6.32 }, [
			{ name: "Paris", placetype: "localadmin", lat: 48.8589, lon: 2.347, prominence: 6.31 },
			{ name: "Paris", lat: 33.6609, lon: -95.5555, prominence: 4.4 },
		])

		expect(declaredAmbiguityMarker({ kinds: BARE, tree, lat: 48.8566, lon: 2.3522 })).toBeNull()
	})

	test("declines when the query was not a bare toponym", () => {
		expect(
			declaredAmbiguityMarker({ kinds: ["structured_address"], tree: SPRINGFIELD, lat: 37.2153, lon: -93.2982 })
		).toBeNull()
	})

	test("declines — rather than declaring decisive — when there is nothing to rank", () => {
		// One candidate is not a contest; a marker either way would be a claim about a measurement that was never made.
		const tree = treeOf({ name: "Ouagadougou", lat: 12.3714, lon: -1.5197, prominence: 6.3 }, [])

		expect(declaredAmbiguityMarker({ kinds: BARE, tree, lat: 12.3714, lon: -1.5197 })).toBeNull()
	})

	test("declines when the backend stamped no prominence — unmeasured is not decisive", () => {
		const tree = treeOf({ name: "Springfield", lat: 37.2153, lon: -93.2982, prominence: 5.1 }, [
			{ name: "Springfield", lat: 42.1015, lon: -72.5898, prominence: 5.05 },
		])

		const node = tree.roots[0]!
		node.metadata = { resolver_name: "Springfield" }

		node.alternatives = (node.alternatives as Array<Record<string, unknown>>).map(({ prominence, score, ...rest }) => {
			void prominence
			void score

			return rest
		})

		expect(declaredAmbiguityMarker({ kinds: BARE, tree, lat: 37.2153, lon: -93.2982 })).toBeNull()
	})
})
