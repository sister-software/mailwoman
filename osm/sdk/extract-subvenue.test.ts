/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins the pure seams of the sub-venue extractor: the hstore parser, the per-layer OGRSQL builder,
 *   the tag-rule matcher, and the feature decoder. `extractOSMSubVenues` itself spawns `ogr2ogr` and
 *   is not exercised here (GDAL is not a test dependency) — but the GeoJSON feature literals below
 *   are NOT invented. They are the verbatim stdout of the system `ogr2ogr` (GDAL 3.8.4) run against
 *   `fixtures/subvenue.osm` with the SQL {@link buildSubVenueSQL} produces, captured 2026-08-04.
 *   That is what makes the decoder test meaningful: it decodes bytes GDAL actually emitted, including
 *   the per-layer promoted/hstore split that the module docstring turns on.
 *
 *   Reproduce the capture with:
 *
 *   ```sh
 *   ogr2ogr -f GeoJSONSeq /vsistdout/ -dialect OGRSQL -sql "<buildSubVenueSQL('points')>" osm/fixtures/subvenue.osm
 *   ogr2ogr -f GeoJSONSeq /vsistdout/ -dialect OGRSQL -sql "<buildSubVenueSQL('multipolygons')>" osm/fixtures/subvenue.osm
 *   ```
 */

import { expect, test } from "vitest"

import {
	buildSubVenueSQL,
	harvestLocalizedNames,
	matchSubVenueTagRule,
	parseOSMHstore,
	SUBVENUE_TAG_RULES,
	SubVenueTier,
	toSubVenueSourceRow,
	distinctSubVenueTagKeys,
} from "./extract-subvenue.ts"

const TAG_KEYS = distinctSubVenueTagKeys(SUBVENUE_TAG_RULES)

test("parseOSMHstore: decodes GDAL's quoted-pair rendering", () => {
	expect(parseOSMHstore(`"aeroway"=>"terminal","name:ja"=>"ターミナル5"`)).toEqual({
		aeroway: "terminal",
		"name:ja": "ターミナル5",
	})
})

test("parseOSMHstore: a comma INSIDE a value does not split the pair", () => {
	// The reason this is a scanner and not a `.split(",")`. Real OSM names carry commas.
	expect(parseOSMHstore(`"name"=>"Terminal 1, Departures","aeroway"=>"terminal"`)).toEqual({
		name: "Terminal 1, Departures",
		aeroway: "terminal",
	})
})

test("parseOSMHstore: honors backslash escapes", () => {
	expect(parseOSMHstore(`"name"=>"The \\"Old\\" Wing","ref"=>"C\\\\1"`)).toEqual({
		name: 'The "Old" Wing',
		ref: "C\\1",
	})
})

test("parseOSMHstore: empty and missing input yield an empty dict, not a throw", () => {
	expect(parseOSMHstore(null)).toEqual({})
	expect(parseOSMHstore("")).toEqual({})
	expect(parseOSMHstore(`"unterminated`)).toEqual({})
})

test("buildSubVenueSQL: reads aeroway bare on multipolygons and via hstore on points", () => {
	// The per-layer promotion split the module docstring turns on, verified against the installed
	// osmconf.ini: `aeroway` is promoted on multipolygons only, `ref` on points only.
	const points = buildSubVenueSQL("points")
	const areas = buildSubVenueSQL("multipolygons")

	expect(points).toContain("hstore_get_value(other_tags,'aeroway') AS aeroway")
	expect(points).toContain("SELECT name, ref,")
	expect(areas).toContain("aeroway AS aeroway")
	expect(areas).not.toContain("hstore_get_value(other_tags,'aeroway')")
	expect(areas).not.toContain("SELECT name, ref,")
})

test("buildSubVenueSQL: always selects other_tags wholesale for the name:<lang> harvest", () => {
	expect(buildSubVenueSQL("points")).toContain("other_tags")
	expect(buildSubVenueSQL("multipolygons")).toContain("other_tags")
})

test("buildSubVenueSQL: refuses a rule table with an OGRSQL-injecting value", () => {
	expect(() =>
		buildSubVenueSQL("points", [
			{ designatorID: "evil", tier: SubVenueTier.SubVenue, all: [["aeroway", "x' OR 1=1 --"]] },
		])
	).toThrow(/allowlist/)
})

test("matchSubVenueTagRule: the aeroway pair resolves to its designator and sub-venue tier", () => {
	expect(matchSubVenueTagRule({ aeroway: "terminal" })).toMatchObject({
		designatorID: "terminal",
		tier: SubVenueTier.SubVenue,
	})

	expect(matchSubVenueTagRule({ aeroway: "gate" })).toMatchObject({ designatorID: "gate" })

	expect(matchSubVenueTagRule({ aeroway: "aerodrome" })).toMatchObject({
		designatorID: "airport",
		tier: SubVenueTier.Venue,
	})
})

test("matchSubVenueTagRule: the two platform branches agree, so first-wins is harmless", () => {
	expect(matchSubVenueTagRule({ railway: "platform" })?.designatorID).toBe("platform")
	expect(matchSubVenueTagRule({ public_transport: "platform" })?.designatorID).toBe("platform")
	expect(matchSubVenueTagRule({ railway: "platform", public_transport: "platform" })?.designatorID).toBe("platform")
})

test("matchSubVenueTagRule: unrelated tags match nothing", () => {
	expect(matchSubVenueTagRule({ highway: "bus_stop" })).toBeNull()
	expect(matchSubVenueTagRule({})).toBeNull()
})

test("harvestLocalizedNames: keeps language subtags and drops OSM's non-linguistic name:* keys", () => {
	expect(
		harvestLocalizedNames({
			"name:ja": "ターミナル5",
			"name:zh-Hant": "第五航廈",
			"name:left": "東側",
			"name:etymology": "someone",
			"name:signed": "no",
			name: "Terminal 5",
		})
	).toEqual({ ja: "ターミナル5", "zh-Hant": "第五航廈" })
})

test("toSubVenueSourceRow: decodes a real points-layer feature, hstore aeroway and all", () => {
	// Verbatim ogr2ogr stdout — `aeroway` arrived through the hstore alias, `ref` as a bare column.
	const feature = {
		type: "Feature",
		properties: {
			name: "Terminal 5",
			ref: "5",
			other_tags: `"aeroway"=>"terminal","name:ja"=>"ターミナル5"`,
			aeroway: "terminal",
		},
		geometry: { type: "Point", coordinates: [-0.4543, 51.47] },
	}

	expect(toSubVenueSourceRow(feature, SUBVENUE_TAG_RULES, TAG_KEYS)).toEqual({
		designatorID: "terminal",
		tier: SubVenueTier.SubVenue,
		name: "Terminal 5",
		ref: "5",
		localizedNames: { ja: "ターミナル5" },
		longitude: -0.4543,
		latitude: 51.47,
		matchedTag: "aeroway=terminal",
		country: "",
	})
})

test("toSubVenueSourceRow: decodes a real multipolygons feature, aeroway promoted and name:de in the hstore", () => {
	const feature = {
		type: "Feature",
		properties: {
			name: "North Terminal",
			aeroway: "terminal",
			other_tags: `"name:de"=>"Nordterminal"`,
		},
		geometry: {
			type: "MultiPolygon",
			coordinates: [
				[
					[
						[-0.455, 51.471],
						[-0.454, 51.471],
						[-0.454, 51.4715],
						[-0.455, 51.4715],
						[-0.455, 51.471],
					],
				],
			],
		},
	}

	const row = toSubVenueSourceRow(feature, SUBVENUE_TAG_RULES, TAG_KEYS)

	expect(row).toMatchObject({
		designatorID: "terminal",
		name: "North Terminal",
		ref: null,
		localizedNames: { de: "Nordterminal" },
		matchedTag: "aeroway=terminal",
	})

	// Ring-vertex average of the four distinct corners (the closing vertex is dropped).
	expect(row!.longitude).toBeCloseTo(-0.4545, 6)
	expect(row!.latitude).toBeCloseTo(51.47125, 6)
})

test("toSubVenueSourceRow: a gate with only a ref still yields — that is the common shape", () => {
	const feature = {
		type: "Feature",
		properties: { ref: "A12", other_tags: `"aeroway"=>"gate"`, aeroway: "gate" },
		geometry: { type: "Point", coordinates: [-0.4544, 51.4701] },
	}

	expect(toSubVenueSourceRow(feature, SUBVENUE_TAG_RULES, TAG_KEYS)).toMatchObject({
		designatorID: "gate",
		name: null,
		ref: "A12",
	})
})

test("toSubVenueSourceRow: a matched feature with no name of any kind is dropped", () => {
	const feature = {
		type: "Feature",
		properties: { other_tags: `"railway"=>"platform","public_transport"=>"platform"` },
		geometry: { type: "Point", coordinates: [1, 2] },
	}

	expect(toSubVenueSourceRow(feature, SUBVENUE_TAG_RULES, TAG_KEYS)).toBeNull()
})

test("toSubVenueSourceRow: a non-matching feature is dropped even if GDAL emitted it", () => {
	const feature = {
		type: "Feature",
		properties: { name: "Not A Terminal", other_tags: `"highway"=>"bus_stop"` },
		geometry: { type: "Point", coordinates: [1, 1] },
	}

	expect(toSubVenueSourceRow(feature, SUBVENUE_TAG_RULES, TAG_KEYS)).toBeNull()
})

test("toSubVenueSourceRow: Terminal Sur survives with its localized surfaces intact", () => {
	// The exact row the corpus task names as the point of the whole exercise.
	const feature = {
		type: "Feature",
		properties: {
			name: "Terminal Sur",
			other_tags: `"aeroway"=>"terminal","name:es"=>"Terminal Sur","name:en"=>"South Terminal"`,
			aeroway: "terminal",
		},
		geometry: { type: "Point", coordinates: [-99.0719, 19.4361] },
	}

	expect(toSubVenueSourceRow(feature, SUBVENUE_TAG_RULES, TAG_KEYS)).toMatchObject({
		name: "Terminal Sur",
		localizedNames: { es: "Terminal Sur", en: "South Terminal" },
	})
})
