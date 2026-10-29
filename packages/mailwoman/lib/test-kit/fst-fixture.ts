/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A small gazetteer FST built in memory from a list of places, for the autocomplete and selection tests.
 */

import { FSTMatcher, normalizeTokens, type PlacetypeID } from "@mailwoman/resolver-wof-sqlite/fst"

/**
 * One place a fixture FST accepts, by its normalized name tokens.
 */
export interface FixturePlace {
	wofID: number
	placetype: PlacetypeID
	name: string
	referential: number
	parentChain: number[]
}

type FixtureEntry = FixturePlace & {
	lat: number
	lon: number
	encyclopedic: number | null
	crossCountryBranches: number | null
}

/**
 * A matcher whose trie accepts each place's name tokens and emits the place at the final state.
 */
export function buildFixtureFST(places: readonly FixturePlace[]): FSTMatcher {
	const nodes: Array<{ edges: Map<string, number>; places: FixtureEntry[] }> = [{ edges: new Map(), places: [] }]

	for (const place of places) {
		const tokens = normalizeTokens(place.name)

		if (!tokens.length) continue

		let stateID = 0

		for (const token of tokens) {
			const node = nodes[stateID]!
			let next = node.edges.get(token)

			if (!next) {
				next = nodes.length
				nodes.push({ edges: new Map(), places: [] })
				node.edges.set(token, next)
			}

			stateID = next
		}

		const node = nodes[stateID]!

		if (!node.places.some((existing) => existing.wofID === place.wofID)) {
			node.places.push({ ...place, lat: 0, lon: 0, encyclopedic: null, crossCountryBranches: null })
		}
	}

	return FSTMatcher.fromNodes(nodes)
}

/**
 * Six United States places, with prefixes shared by two of them.
 */
export const FIXTURE_FST_PLACES: readonly FixturePlace[] = [
	{
		wofID: 85_977_539,
		placetype: "locality",
		name: "New York City",
		referential: 0.9,
		parentChain: [85_688_543, 85_633_793],
	},
	{ wofID: 85_688_543, placetype: "region", name: "New York", referential: 0.75, parentChain: [85_633_793] },
	{
		wofID: 85_935_903,
		placetype: "locality",
		name: "New Orleans",
		referential: 0.6,
		parentChain: [85_688_481, 85_633_793],
	},
	{
		wofID: 85_922_583,
		placetype: "locality",
		name: "San Francisco",
		referential: 0.85,
		parentChain: [102_087_579, 85_633_793],
	},
	{
		wofID: 85_919_487,
		placetype: "locality",
		name: "San Jose",
		referential: 0.5,
		parentChain: [102_087_579, 85_633_793],
	},
	{ wofID: 85_633_793, placetype: "country", name: "United States", referential: 0.99, parentChain: [] },
]
