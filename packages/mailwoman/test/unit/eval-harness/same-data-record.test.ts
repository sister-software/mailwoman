/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What the recorder withholds, which is what the withheld-gold stratum means.
 *
 *   `same-data-resolver-v1` withholds the ids the `gn:id` concordance linked. That leaves the gazetteer's
 *   second row for the same settlement answerable — 285,478 of 2,689,326 populated localities share a
 *   folded name with a `localadmin` within 5 km — so an arm returning the twin was graded as selecting
 *   where no correct candidate exists, on 10 of that panel's 100 withheld rows.
 *
 *   `withholdEveryDenotingRow` is the corrected rule and it is off by default, because turning it on
 *   changes what the stratum means and the v1 arms have already run. These tests pin both halves: the
 *   default stays id-equality byte-for-byte, and the opt-in catches the twin without catching a real
 *   namesake at distance.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import type { SameDataPanelRow } from "mailwoman/eval-harness/same-data/fixture"
import { recordFixture } from "mailwoman/eval-harness/same-data/record"
import { describe, expect, it } from "vitest"

/**
 * Troyes as the gazetteer carries it: the concorded `locality`, its `localadmin` twin 0.6 km away, and a real namesake
 * far enough off to be a different place.
 */
const TROYES: ResolvedPlace[] = [
	{ id: 101_750_981, name: "Troyes", placetype: "locality", country: "FR", lat: 48.2973, lon: 4.0744, score: 5 },
	{ id: 404_405_659, name: "Troyes", placetype: "localadmin", country: "FR", lat: 48.2921, lon: 4.0801, score: 4 },
	{ id: 999, name: "Troyes", placetype: "locality", country: "CA", lat: 45.5, lon: -73.6, score: 1 },
]

const PANEL: SameDataPanelRow[] = [
	{
		id: "gold_absent-001",
		stratum: "gold_absent",
		query: "Troyes",
		goldPresent: false,
		gold: {
			geonameid: "2971071",
			// Only the concorded id — the twin is exactly what v1 leaves answerable.
			placeIDs: [101_750_981],
			name: "Troyes",
			country: "FR",
			admin1: "GES",
			lat: 48.2973,
			lon: 4.0744,
			population: 61_996,
		},
		source: { register: "geonames:cities15000", license: "CC-BY-4.0", attribution: "GeoNames" },
	},
]

const backend: ResolverBackend = {
	async findPlace() {
		return TROYES.map((place) => ({ ...place }))
	},
}

const parse = async (query: string): Promise<AddressTree> => ({
	raw: query,
	roots: [{ tag: "locality", value: query, start: 0, end: query.length, confidence: 0.9, children: [] }],
})

/**
 * Every candidate id the recording actually kept, across every question it asked.
 */
async function recordedIDs(withholdEveryDenotingRow: boolean): Promise<Set<string>> {
	const { fixture } = await recordFixture({
		panel: PANEL,
		backend,
		parse,
		armOptions: [{}],
		withholdEveryDenotingRow,
	})

	const ids = new Set<string>()

	for (const lookup of fixture[0]!.lookups) {
		for (const candidate of lookup.candidates) {
			ids.add(String(candidate.id))
		}
	}

	return ids
}

describe("the same-data recorder's withholding rule", () => {
	it("by default withholds ID EQUALITY only — the v1 rule, twin left answerable", async () => {
		const ids = await recordedIDs(false)

		expect(ids.has("101750981")).toBe(false) // the concorded gold
		// The defect v1 carries: one settlement, two rows, one link. The `localadmin` survives the filter
		// and an arm returning it was graded as inventing a place.
		expect(ids.has("404405659")).toBe(true)
		expect(ids.has("999")).toBe(true)
	})

	it("#2268: the opt-in withholds every row DENOTING the gold place", async () => {
		const ids = await recordedIDs(true)

		expect(ids.has("101750981")).toBe(false)
		expect(ids.has("404405659")).toBe(false) // the twin, 0.6 km away under the same folded name
	})

	it("#2268: a real namesake at distance survives — both halves of the rule are required", async () => {
		const ids = await recordedIDs(true)

		// `Troyes` QC folds equal and sits thousands of km away. Withholding it would remove a candidate
		// the stratum is entitled to offer, which is the `Batāla` case: same fold, 1,421 km apart.
		expect(ids.has("999")).toBe(true)
	})
})
