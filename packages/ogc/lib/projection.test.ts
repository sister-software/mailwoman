// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { GeocodeResult } from "@mailwoman/core/geocode"
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
			hits.map(({ collectionID, displayName, score, scoreUnmeasured }) => ({
				collectionID,
				displayName,
				score,
				scoreUnmeasured,
			}))
		).toEqual([
			{
				collectionID: "places",
				displayName: "Camden, United States",
				score: CAMDEN_NJ.score,
				scoreUnmeasured: undefined,
			},
			{
				collectionID: "places",
				displayName: "Camden, United States",
				score: CAMDEN_NJ.score,
				scoreUnmeasured: undefined,
			},
			{
				collectionID: "postcodes",
				displayName: "Camden, United States",
				score: null,
				scoreUnmeasured: "population_unrecorded",
			},
		])
	})

	test("a result without a coordinate or candidates has no match", () => {
		expect(geocodeSearchHits(geocodeResult({ input: "zzzz" }))).toEqual([])
	})
})
