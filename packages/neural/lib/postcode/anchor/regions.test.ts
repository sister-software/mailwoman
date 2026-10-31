/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PostcodePrefixIndexResolver, serializePostcodePrefixIndex } from "@mailwoman/postcode/prefix/index"
import { describe, expect, it } from "vitest"

import { createAnchorRegionLookup, prefixForLevel } from "#postcode/anchor/regions"

const US = { placetype: "country", wofID: 85_633_793, name: "United States" }
const VERMONT = { placetype: "region", wofID: 85_688_763, name: "Vermont" }
const UK = { placetype: "country", wofID: 85_633_159, name: "United Kingdom" }
const ENGLAND = { placetype: "macroregion", wofID: 404_227_469, name: "England" }

function header(country: string, scope: string, levels: string[]) {
	return {
		country,
		scope,
		schemaVersion: 1 as const,
		levels,
		source: "test",
		sourceMD5s: [],
		buildDate: "2026-10-15",
		tier: "shipped" as const,
		attribution: "test",
		coverageNote: "test",
	}
}

describe("prefixForLevel", () => {
	it("takes a digit count or a GB outward code, and refuses a code too short for the level", () => {
		expect(prefixForLevel("05448", "3")).toBe("054")
		expect(prefixForLevel("05", "3")).toBeNull()
		expect(prefixForLevel("SW1A 2AA", "outward")).toBe("SW1A")
		expect(prefixForLevel("SW1A", "outward")).toBe("S")
		expect(prefixForLevel("2AA", "outward")).toBeNull()
		expect(prefixForLevel("05448", "zero")).toBeNull()
	})
})

describe("createAnchorRegionLookup", () => {
	const us = new PostcodePrefixIndexResolver(
		new Uint8Array(
			serializePostcodePrefixIndex(header("us", "us", ["3"]), [
				{ prefix: "054", ancestors: [US, VERMONT], lat: 44.6, lon: -73, radiusP95Km: 51.6, unitCount: 60 },
				{ prefix: "205", ancestors: [US], lat: 38.9, lon: -77, radiusP95Km: 5.2, unitCount: 75 },
			])
		)
	)

	const gb = new PostcodePrefixIndexResolver(
		new Uint8Array(
			serializePostcodePrefixIndex(header("gb", "gb-esw", ["outward"]), [
				{ prefix: "SW1A", ancestors: [UK, ENGLAND], lat: null, lon: null, radiusP95Km: null, unitCount: 10 },
			])
		)
	)

	it("answers a postcode through its country's index at the index's own level", () => {
		const lookup = createAnchorRegionLookup([us, gb])

		expect(lookup.ancestorsFor("05448", "US")).toEqual([US, VERMONT])
		expect(lookup.ancestorsFor("20500", "US")).toEqual([US])
		expect(lookup.ancestorsFor("99999", "US")).toEqual([])
		expect(lookup.ancestorsFor("SW1A2AA", "GB")).toEqual([UK, ENGLAND])
		expect(lookup.ancestorsFor("05448", "GB")).toEqual([])
	})
})
