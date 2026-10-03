/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `diffGeocode` — saying why the answer moved rather than just that it did.
 *
 *   A distance delta is the geocoding equivalent of a component map: it reports that the answer moved and not which of
 *   three unrelated problems caused it. These tests distinguish the three because each needs a different fix.
 *   A parse change is a model problem. A repoint is a ranking or gazetteer problem. A tier change is a data-coverage
 *   problem that model work cannot change.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { diffGeocode, renderGeocodeDiff, type GeocodeArm } from "#geocode"

/**
 * A tree of resolved spans: `[tag, value, start, end, confidence, placeID?, lat?, lon?, candidates?]`.
 */
function tree(
	...nodes: Array<[string, string, number, number, number, string?, number?, number?, number?]>
): AddressTree {
	return {
		raw: INPUT,
		roots: nodes.map(([tag, value, start, end, confidence, placeID, lat, lon, candidates]): AddressNode => {
			const node: AddressNode = { tag: tag as ComponentTag, value, start, end, confidence, children: [] }

			if (placeID) {
				node.placeID = placeID
			}

			if (lat !== undefined) {
				node.lat = lat
			}

			if (lon !== undefined) {
				node.lon = lon
			}

			if (candidates !== undefined) {
				node.alternatives = Array.from({ length: candidates }, () => ({}))
			}

			return node
		}),
	}
}

const INPUT = "27 Minories, London EC3N 1DE"

describe("diffGeocode", () => {
	it("attributes a move to the PARSE when the parse changed", () => {
		// The resolver was asked a different question.
		// Retrieval is not the suspect and a distance delta by itself would have pointed at it.
		const before: GeocodeArm = {
			tree: tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5, -0.12, 3]),
			lat: 51.5,
			lon: -0.12,
			tier: "admin",
		}

		const after: GeocodeArm = {
			tree: tree(["venue", "London", 13, 19, 0.6, "wof:101750367", 51.5, -0.12, 3]),
			lat: 51.5,
			lon: -0.12,
			tier: "admin",
		}

		expect(diffGeocode(INPUT, before, after).attribution).toBe("parse-changed")
	})

	it("attributes a move to RETRIEVAL when the parse held and a span repointed", () => {
		// Same text, same tag, different place.
		// This is a ranking or gazetteer-coverage problem.
		// The placeID is the only signal that shows it.
		const before: GeocodeArm = {
			tree: tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5074, -0.1278, 2]),
			lat: 51.5074,
			lon: -0.1278,
			tier: "admin",
		}

		const after: GeocodeArm = {
			tree: tree(["locality", "London", 13, 19, 0.9, "wof:85950361", 42.9834, -81.233, 40]),
			lat: 42.9834,
			lon: -81.233,
			tier: "admin",
		}

		const diff = diffGeocode(INPUT, before, after)

		expect(diff.attribution).toBe("retrieval-repointed")
		expect(diff.spanGeo[0]?.kind).toBe("repointed")
		expect(diff.spanGeo[0]?.placeIDBefore).toBe("wof:101750367")
		expect(diff.spanGeo[0]?.placeIDAfter).toBe("wof:85950361")
		// London, England to London, Ontario is most of the way across the Atlantic.
		expect(diff.movedKm).toBeGreaterThan(5000)
	})

	it("attributes a move to the TIER when parse and places both held", () => {
		// The same components fell through to a coarser rung because a rooftop lookup missed.
		// Model changes cannot affect this.
		// A model-regression report would waste a training run.
		const node = tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5074, -0.1278, 2])
		const before: GeocodeArm = { tree: node, lat: 51.5074, lon: -0.1278, tier: "address_point", uncertaintyM: 5 }
		const after: GeocodeArm = { tree: node, lat: 51.5074, lon: -0.1278, tier: "admin", uncertaintyM: 4000 }

		const diff = diffGeocode(INPUT, before, after)

		expect(diff.attribution).toBe("tier-changed")
		expect(renderGeocodeDiff(diff)).toContain("tier address_point → admin")
	})

	it("keeps a LOST coordinate distinct from a zero-kilometer move", () => {
		// Undefined distance and zero distance are different events.
		// A collapsed value would confuse an unknown distance with a measured zero.
		const node = tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5, -0.12, 2])

		const diff = diffGeocode(
			INPUT,
			{ tree: node, lat: 51.5, lon: -0.12, tier: "admin" },
			{ tree: node, lat: null, lon: null }
		)

		expect(diff.attribution).toBe("coordinate-appeared-or-vanished")
		expect(diff.movedKm).toBeUndefined()
		expect(renderGeocodeDiff(diff)).toContain("LOST its coordinate")
	})

	it("reports retrieval BREADTH even when the span kept its place", () => {
		// Same answer from 40 candidates instead of 2 is one gazetteer edit from moving.
		// An answer that has not changed yet is not the same as an answer that is stable.
		const before: GeocodeArm = {
			tree: tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5, -0.12, 2]),
			lat: 51.5,
			lon: -0.12,
			tier: "admin",
		}

		const after: GeocodeArm = {
			tree: tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5, -0.12, 40]),
			lat: 51.5,
			lon: -0.12,
			tier: "admin",
		}

		const diff = diffGeocode(INPUT, before, after)

		expect(diff.spanGeo[0]?.candidatesBefore).toBe(2)
		expect(diff.spanGeo[0]?.candidatesAfter).toBe(40)
		expect(renderGeocodeDiff(diff)).toContain("candidates 2 → 40")
	})

	it("says unchanged when nothing moved", () => {
		const node = tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5, -0.12, 2])
		const arm: GeocodeArm = { tree: node, lat: 51.5, lon: -0.12, tier: "admin" }

		const diff = diffGeocode(INPUT, arm, arm)

		expect(diff.attribution).toBe("unchanged")
		expect(diff.identical).toBe(true)
	})

	it("renders the ADDRESS first and the attribution before the numbers", () => {
		const before: GeocodeArm = {
			tree: tree(["locality", "London", 13, 19, 0.9, "wof:101750367", 51.5074, -0.1278, 2]),
			lat: 51.5074,
			lon: -0.1278,
			tier: "admin",
		}

		const after: GeocodeArm = {
			tree: tree(["locality", "London", 13, 19, 0.9, "wof:85950361", 42.9834, -81.233, 40]),
			lat: 42.9834,
			lon: -81.233,
			tier: "admin",
		}

		const out = renderGeocodeDiff(diffGeocode(INPUT, before, after))

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- a handful of lines about one address
		const lines = out.split("\n")

		expect(lines[0]).toBe(INPUT)
		expect(lines[1]).toContain("attribution: retrieval-repointed")
		expect(out).toContain("place wof:101750367 → wof:85950361")
	})
})
