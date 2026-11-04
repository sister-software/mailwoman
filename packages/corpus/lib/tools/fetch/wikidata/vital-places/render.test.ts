/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { VitalPlace } from "#tools/fetch/wikidata/vital-places/inventory"
import {
	holdsOutVitalPlace,
	renderVitalPlaceForms,
	renderVitalPlaces,
	VITAL_PLACE_RENDERINGS,
	vitalPlaceRendering,
} from "#tools/fetch/wikidata/vital-places/render"

// The roots follow Wikidata's tree. Q1440300 (observation tower) sits under both Q811979 and Q56061.
// Q515 (city) sits under Q486972 only. Q46169 (national park) sits under Q56061 and Q473972.
// Q4022 (river) sits under neither a settlement nor a site root.
const ROOTS = {
	Q1440300: ["Q811979", "Q56061", "Q618123"],
	Q515: ["Q486972", "Q618123"],
	Q46169: ["Q56061", "Q473972"],
	Q4022: ["Q618123"],
	// Q79007 (street) sits under Q811979 and itself, as Calle de Alcalá's class does.
	Q79007: ["Q811979", "Q79007"],
}

function place(overrides: Partial<VitalPlace>): VitalPlace {
	return {
		qid: "Q1",
		qrank: 1,
		classes: [],
		countries: ["Q142"],
		coordinate: { lat: 48.8, lon: 2.3 },
		population: null,
		sitelinks: 10,
		labels: {},
		aliases: {},
		countryCodes: ["FR"],
		...overrides,
	}
}

const COUNTRY_NAMES: Record<string, string> = { "FR/en": "France", "FR/de": "Frankreich", "FR/ja": "フランス" }

const countryName = (code: string, language: string): string | undefined => COUNTRY_NAMES[`${code}/${language}`]

describe("vitalPlaceRendering", () => {
	test("a built place under an administrative root renders as a venue", () => {
		expect(vitalPlaceRendering(place({ classes: ["Q1440300"] }), ROOTS)).toBe(VITAL_PLACE_RENDERINGS.venue)
	})

	test("a national park renders as a venue", () => {
		expect(vitalPlaceRendering(place({ classes: ["Q46169"] }), ROOTS)).toBe(VITAL_PLACE_RENDERINGS.venue)
	})

	test("a settlement is left to Who's On First", () => {
		expect(vitalPlaceRendering(place({ classes: ["Q515"], population: 2_100_000 }), ROOTS)).toBe(
			VITAL_PLACE_RENDERINGS.settlement
		)
	})

	test("a populated settlement that is also a site stays a settlement", () => {
		expect(vitalPlaceRendering(place({ classes: ["Q515", "Q1440300"], population: 2_100_000 }), ROOTS)).toBe(
			VITAL_PLACE_RENDERINGS.settlement
		)
	})

	test("a named street is left to the street sources", () => {
		expect(vitalPlaceRendering(place({ classes: ["Q79007"] }), ROOTS)).toBe(VITAL_PLACE_RENDERINGS.road)
	})

	test("a place whose countries state no code renders no rows", () => {
		expect(vitalPlaceRendering(place({ classes: ["Q4022"], countryCodes: [] }), ROOTS)).toBe(
			VITAL_PLACE_RENDERINGS.noCountry
		)
	})
})

describe("renderVitalPlaceForms", () => {
	test("renders bare labels, comma-language country forms and the first new English alias", () => {
		const forms = renderVitalPlaceForms(
			{
				labels: { en: "Eiffel Tower", de: "Eiffelturm", ja: "エッフェル塔" },
				aliases: { en: ["Eiffel Tower", "La dame de fer", "Tour Eiffel"] },
			},
			"FR",
			countryName
		)

		expect(forms.map((form) => form.raw)).toEqual([
			"Eiffel Tower",
			"Eiffel Tower, France",
			"Eiffelturm",
			"Eiffelturm, Frankreich",
			"エッフェル塔",
			"La dame de fer",
		])
		expect(forms[1]!.components).toEqual({ venue: "Eiffel Tower", country: "France" })
	})

	test("skips a name holding a comma or parenthesis", () => {
		const forms = renderVitalPlaceForms(
			{ labels: { en: "Neatsville, Kentucky", fr: "Tour (Paris)" }, aliases: {} },
			"FR",
			countryName
		)

		expect(forms).toEqual([])
	})
})

describe("renderVitalPlaces", () => {
	test("an entity's rows all go to the same side of the holdout", () => {
		const places = Array.from({ length: 200 }, (_, index) =>
			place({ qid: `Q${index + 10}`, classes: ["Q4022"], labels: { en: `River ${index}`, de: `Fluss ${index}` } })
		)

		const render = renderVitalPlaces(places, ROOTS, new Set(), countryName)
		const trained = new Set(render.rows.map((row) => row.qid))

		expect(render.holdout.length).toBeGreaterThan(0)
		expect(render.holdout.every((row) => !trained.has(row.qid))).toBe(true)
		expect(render.counts.heldOutEntities + render.counts.trainedEntities).toBe(places.length)
	})

	test("an exempt entity always trains", () => {
		const heldOut = Array.from({ length: 500 }, (_, index) => `Q${index}`).find((qid) => holdsOutVitalPlace(qid))!

		expect(holdsOutVitalPlace(heldOut, new Set([heldOut]))).toBe(false)
	})
})
