// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { Ancestor } from "@mailwoman/core/resolver"
import { describe, expect, test } from "vitest"

import { geocodeSearchHits, OGCCollectionID } from "#index"

/**
 * A geocode result with every field the projection doesn't read left empty.
 */
function geocodeResult(fields: Partial<GeocodeResult> & Pick<GeocodeResult, "input">): GeocodeResult {
	return {
		components: {},
		dropped_components: null,
		unfollowed_components: null,
		lat: null,
		lon: null,
		resolution_tier: "admin",
		epistemic_status: "observed",
		derivation: null,
		entity: null,
		rooftop: null,
		coordinate_source: null,
		uncertainty_m: null,
		locality: null,
		region: null,
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		countryCode: null,
		hierarchy: [],
		candidates: [],
		postcode_country_scope: null,
		capital_promotion: null,
		variant_alias_exemption: "not_applied",
		intent_markers: [],
		admin_coherence: null,
		authoritative: null,
		...fields,
	}
}

// The fields below are the ones `mw geocode --json` printed for each input on 2026-11-20.
const AMSTERDAM = {
	name: "Amsterdam",
	tag: "locality",
	value: "Amsterdam",
	placetype: "locality",
	lat: 52.37243,
	lon: 4.89973,
	countryCode: "NL",
	placeID: "wof:101751893",
	score: 5.92097073042671,
}

const CAMDEN_NJ = {
	name: "Camden",
	tag: "locality",
	value: "Camden",
	placetype: "locality",
	lat: 39.936906,
	lon: -75.11261,
	countryCode: "US",
	placeID: "wof:85975673",
	score: 4.8518757089073725,
}

describe("geocodeSearchHits", () => {
	test("an address-point answer is an address with no measured score, followed by its locality", () => {
		const hits = geocodeSearchHits(
			geocodeResult({
				input: "Dam 1, 1012JS Amsterdam",
				lat: 52.3732926,
				lon: 4.8937175,
				resolution_tier: "address_point",
				house_number: "1",
				street: "Dam",
				postcode: "1012JS",
				locality: "Amsterdam",
				countryCode: "NL",
				rooftop: { localityNorm: "amsterdam", postcode: "1012JS" },
				hierarchy: [{ ...AMSTERDAM, in_winner_lineage: true }],
				candidates: [AMSTERDAM],
			})
		)

		expect(hits).toEqual([
			{
				collectionID: OGCCollectionID.Addresses,
				lon: 4.8937175,
				lat: 52.3732926,
				displayName: "Dam 1, 1012JS Amsterdam, Netherlands",
				score: null,
				scoreUnmeasured: "unrecorded",
			},
			{
				collectionID: OGCCollectionID.Places,
				lon: 4.89973,
				lat: 52.37243,
				displayName: "Amsterdam, Netherlands",
				score: 5.92097073042671,
				placeID: "wof:101751893",
				placetype: "locality",
			},
		])
	})

	test("a place answer takes its candidate's score, and a second place at the same coordinate stays a match", () => {
		const localadmin = { ...CAMDEN_NJ, placetype: "localadmin", placeID: "wof:404477989" }
		const postcode = { ...CAMDEN_NJ, placetype: "postalcode", placeID: "wof:1", lat: 1, lon: 1, score: null }

		const hits = geocodeSearchHits(
			geocodeResult({
				input: "Camden",
				lat: CAMDEN_NJ.lat,
				lon: CAMDEN_NJ.lon,
				locality: "Camden",
				countryCode: "US",
				hierarchy: [{ ...CAMDEN_NJ, in_winner_lineage: true }],
				candidates: [
					CAMDEN_NJ,
					localadmin,
					{ ...postcode, scoreUnmeasured: "population_unrecorded" },
					{ ...AMSTERDAM, tag: "region" },
				],
			})
		)

		expect(
			hits.map(({ collectionID, placeID, placetype, score, scoreUnmeasured }) => ({
				collectionID,
				placeID,
				placetype,
				score,
				scoreUnmeasured,
			}))
		).toEqual([
			{
				collectionID: "places",
				placeID: "wof:85975673",
				placetype: "locality",
				score: CAMDEN_NJ.score,
				scoreUnmeasured: undefined,
			},
			{
				collectionID: "places",
				placeID: "wof:404477989",
				placetype: "localadmin",
				score: CAMDEN_NJ.score,
				scoreUnmeasured: undefined,
			},
			{
				collectionID: "postcodes",
				placeID: "wof:1",
				placetype: "postalcode",
				score: null,
				scoreUnmeasured: "population_unrecorded",
			},
		])
	})

	test("two places sharing a name and country are labeled with the regions the gazetteer records", () => {
		const camdenAR = {
			...CAMDEN_NJ,
			placeID: "wof:85921237",
			lat: 33.567931,
			lon: -92.839659,
			score: 4.0071501053666845,
		}

		// The lineages `candidate_ancestor` records for each place in the 2026-11-19 candidate gazetteer.
		// Camden, New Jersey sits in a localadmin and a county whose gazetteer name is also Camden.
		const ancestries: Record<number, Ancestor[]> = {
			85_975_673: [
				{ id: 1, placetype: "localadmin", name: "Camden" },
				{ id: 2, placetype: "county", name: "Camden" },
				{ id: 3, placetype: "region", name: "New Jersey" },
				{ id: 4, placetype: "country", name: "United States" },
			],
			85_921_237: [
				{ id: 5, placetype: "county", name: "Ouachita" },
				{ id: 6, placetype: "region", name: "Arkansas" },
				{ id: 4, placetype: "country", name: "United States" },
			],
		}

		const hits = geocodeSearchHits(
			geocodeResult({
				input: "Camden",
				lat: CAMDEN_NJ.lat,
				lon: CAMDEN_NJ.lon,
				countryCode: "US",
				hierarchy: [{ ...CAMDEN_NJ, in_winner_lineage: true }],
				candidates: [CAMDEN_NJ, camdenAR],
			}),
			(wofID) => ancestries[wofID] ?? []
		)

		expect(hits.map((hit) => hit.displayName)).toEqual([
			"Camden, New Jersey, United States",
			"Camden, Ouachita, Arkansas, United States",
		])
	})

	test("a place without a WOF place ID, or without a recorded ancestry, keeps its name and country", () => {
		const unidentified = { ...CAMDEN_NJ, placeID: null, lat: 1, lon: 1 }
		const unrecorded = { ...CAMDEN_NJ, placeID: "wof:404475697", lat: 2, lon: 2 }
		const looked: number[] = []

		const hits = geocodeSearchHits(
			geocodeResult({ input: "Camden", candidates: [unidentified, unrecorded] }),
			(wofID) => {
				looked.push(wofID)

				return []
			}
		)

		expect(hits.map(({ displayName, placeID }) => ({ displayName, placeID }))).toEqual([
			{ displayName: "Camden, United States", placeID: undefined },
			{ displayName: "Camden, United States", placeID: "wof:404475697" },
		])

		expect(looked).toEqual([404_475_697])
	})

	test("a postcode without a recorded ancestry is labeled with its own country, whichever code it records (#3164)", () => {
		// `/search?q=75008` on the 2026-11-19 gazetteer: the Estonian postcode was labeled "75008", without its country.
		const postcode = (placeID: string, countryCode: string, lat: number, lon: number) => ({
			name: "75008",
			tag: "postcode",
			value: "75008",
			placetype: "postalcode",
			lat,
			lon,
			countryCode,
			placeID,
			score: null,
			scoreUnmeasured: "population_unrecorded" as const,
		})

		const hits = geocodeSearchHits(
			geocodeResult({
				input: "75008",
				candidates: [
					postcode("wof:9500000088047", "EE", 59.1094, 25.4043),
					postcode("wof:421307191", "FR", 48.872527, 2.312582),
					postcode("wof:9500000042424", "SE", 59.8585, 17.6454),
				],
			}),
			() => []
		)

		expect(hits.map(({ displayName }) => displayName)).toEqual(["75008, Estonia", "75008, France", "75008, Sweden"])
	})

	test("a result without a coordinate or candidates has no match", () => {
		expect(geocodeSearchHits(geocodeResult({ input: "zzzz" }))).toEqual([])
	})
})
