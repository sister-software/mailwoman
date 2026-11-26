// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { parseJSONStrict } from "@mailwoman/core/values/json"
import { describe, expect, it } from "vitest"

import { formatWOFFeature, patchWOFRecordText, type WOFRecordFeature } from "#tools/pipeline/wof/record"

// Mission Dolores Park (WOF 1108832255) as whosonfirst-data-admin-us stores it: nested arrays
// and objects, integral floats (`18.0`), a small float area and an unsorted `wof:belongsto`.
const MISSION_DOLORES_PARK = [
	"{",
	'  "id": 1108832255,',
	'  "type": "Feature",',
	'  "properties": {',
	'    "edtf:cessation":"uuuu",',
	'    "edtf:inception":"uuuu",',
	'    "geom:area":0.000007,',
	'    "geom:area_square_m":71616.022977,',
	'    "geom:bbox":"-122.428354064,37.758088756,-122.425782133,37.7614328628",',
	'    "geom:latitude":37.759761,',
	'    "geom:longitude":-122.427065,',
	'    "iso:country":"US",',
	'    "lbl:latitude":37.759759,',
	'    "lbl:longitude":-122.427066,',
	'    "lbl:max_zoom":18.0,',
	'    "mps:latitude":37.759759,',
	'    "mps:longitude":-122.427066,',
	'    "mz:hierarchy_label":1,',
	'    "mz:is_current":1,',
	'    "mz:is_funky":0,',
	'    "mz:is_landuse_aoi":1,',
	'    "mz:max_zoom":18.0,',
	'    "mz:min_zoom":16.0,',
	'    "name:ceb_x_preferred":[',
	'        "Mission Dolores Park"',
	"    ],",
	'    "name:eng_x_variant":[',
	'        "Mission-Dolores",',
	'        "Mission Dolores",',
	'        "Mission-Dolores Park"',
	"    ],",
	'    "name:fra_x_preferred":[',
	'        "Dolores Park"',
	"    ],",
	'    "name:ita_x_preferred":[',
	'        "Mission Dolores Park"',
	"    ],",
	'    "reversegeo:latitude":37.759759,',
	'    "reversegeo:longitude":-122.427066,',
	'    "src:geom":"mz",',
	'    "wof:belongsto":[',
	"        85865951,",
	"        102191575,",
	"        1108830809,",
	"        85633793,",
	"        85922583,",
	"        102087579,",
	"        85688637",
	"    ],",
	'    "wof:breaches":[],',
	'    "wof:concordances":{},',
	'    "wof:controlled":[],',
	'    "wof:country":"US",',
	'    "wof:geomhash":"8675f884ba82e21b3c4414a131793334",',
	'    "wof:hierarchy":[',
	"        {",
	'            "continent_id":102191575,',
	'            "country_id":85633793,',
	'            "county_id":102087579,',
	'            "locality_id":85922583,',
	'            "macrohood_id":1108830809,',
	'            "microhood_id":1108832255,',
	'            "neighbourhood_id":85865951,',
	'            "region_id":85688637',
	"        }",
	"    ],",
	'    "wof:id":1108832255,',
	'    "wof:lastmodified":1566624119,',
	'    "wof:name":"Mission Dolores Park",',
	'    "wof:parent_id":85865951,',
	'    "wof:placetype":"microhood",',
	'    "wof:repo":"whosonfirst-data-admin-us",',
	'    "wof:superseded_by":[],',
	'    "wof:supersedes":[],',
	'    "wof:tags":[]',
	"},",
	'  "bbox": [',
	"    -122.4283540639999,",
	"    37.75808875600004,",
	"    -122.42578213269523,",
	"    37.76143286276525",
	"],",
	'  "geometry": {"coordinates":[[[-122.428354,37.76129],[-122.426075,37.761433],[-122.425782,37.758226],[-122.42805,37.758089],[-122.428354,37.76129]]],"type":"Polygon"}',
	"}",
].join("\n")

describe("formatWOFFeature", () => {
	it("prints an exported record's parsed value back to the exporter's bytes", () => {
		const feature = parseJSONStrict<WOFRecordFeature>(MISSION_DOLORES_PARK)

		expect(formatWOFFeature(feature)).toBe(MISSION_DOLORES_PARK)
	})

	it("writes an integral property float and bbox coordinate with `.0`, and a geometry coordinate without", () => {
		const text = formatWOFFeature({
			id: 1,
			type: "Feature",
			properties: { "geom:latitude": 41, "wof:id": 1 },
			bbox: [-81, 41, -81, 41],
			geometry: { type: "Point", coordinates: [-81, 41] },
		})

		expect(text).toContain('"geom:latitude":41.0,')
		expect(text).toContain('"wof:id":1\n')
		expect(text).toContain('{"coordinates":[-81,41],"type":"Point"}')
		expect(text).toContain("    -81.0,\n")
	})
})

describe("patchWOFRecordText", () => {
	// `ne:ADM0CAP` is a float no list declares, so a parse and reprint would write it as `0`.
	const record = [
		"{",
		'  "id": 7,',
		'  "type": "Feature",',
		'  "properties": {',
		'    "mz:is_current":1,',
		'    "ne:ADM0CAP":0.0,',
		'    "wof:hierarchy":[',
		"        {",
		'            "region_id":5',
		"        }",
		"    ],",
		'    "wof:id":7',
		"},",
		'  "bbox": [',
		"    1.0,",
		"    2.0,",
		"    1.0,",
		"    2.0",
		"],",
		'  "geometry": {"coordinates":[1,2],"type":"Point"}',
		"}",
	].join("\n")

	it("returns the text unchanged when no property is set", () => {
		expect(patchWOFRecordText(record, {})).toBe(record)
	})

	it("sets a property and keeps every other byte, including an undeclared float", () => {
		const patched = patchWOFRecordText(record, { "wof:hierarchy": [{ region_id: 9 }] })

		expect(patched).toBe(record.replace('"region_id":5', '"region_id":9'))
	})

	it("places a new property in key order", () => {
		const patched = patchWOFRecordText(record, { "name:eng_x_preferred": ["A"] })

		expect(patched).toContain(
			'    "mz:is_current":1,\n    "name:eng_x_preferred":[\n        "A"\n    ],\n    "ne:ADM0CAP":0.0,'
		)

		expect(patched).toContain('    "wof:id":7\n},')
	})
})
