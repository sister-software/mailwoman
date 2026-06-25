/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import type { WOFProperties } from "./admin.js"
import { parsePlacetypeSource, pluckFileNameLanguageCode, pluckPlacetypeSpec } from "./admin.js"

const baseProps = (over: Partial<WOFProperties> = {}): WOFProperties =>
	({
		"wof:id": 101,
		"wof:name": "London",
		"wof:src": "whosonfirst",
		"src:geom": "geonames",
		"wof:placetype": "locality",
		"wof:parent_id": 404,
		...over,
	}) as WOFProperties

test("parsePlacetypeSource: splits a `name:<lang>_x_<kind>` key; non-localized keys yield undefined", () => {
	expect(parsePlacetypeSource("name:eng_x_preferred")).toEqual({ languageCode: "eng", nameKind: "preferred" })
	expect(parsePlacetypeSource("name:fra_x_variant")).toEqual({ languageCode: "fra", nameKind: "variant" })
	expect(parsePlacetypeSource("wof:name")).toEqual({ languageCode: undefined, nameKind: undefined })
})

test("pluckPlacetypeSpec: passes through identity + resolves the wof→gn population fallback", () => {
	expect(pluckPlacetypeSpec(baseProps())).toMatchObject({
		id: 101,
		name: "London",
		placetype: "locality",
		parent_id: 404,
	})
	// wof:population wins when present…
	expect(pluckPlacetypeSpec(baseProps({ "wof:population": 9_000_000, "gn:population": 8_000_000 })).population).toBe(
		9_000_000
	)
	// …else falls back to gn:population
	expect(pluckPlacetypeSpec(baseProps({ "gn:population": 8_000_000 })).population).toBe(8_000_000)
	expect(pluckPlacetypeSpec(baseProps()).population).toBeUndefined()
})

test("pluckPlacetypeSpec: mz:is_current is tri-state (0/'0' → false, present → true, missing → undefined)", () => {
	expect(pluckPlacetypeSpec(baseProps({ "mz:is_current": 1 })).isCurrent).toBe(true)
	expect(pluckPlacetypeSpec(baseProps({ "mz:is_current": 0 })).isCurrent).toBe(false)
	expect(pluckPlacetypeSpec(baseProps({ "mz:is_current": "0" })).isCurrent).toBe(false)
	expect(pluckPlacetypeSpec(baseProps()).isCurrent).toBeUndefined()
})

test("pluckPlacetypeSpec: lifecycle flags from edtf + superseded arrays", () => {
	expect(pluckPlacetypeSpec(baseProps({ "edtf:deprecated": "2019" })).isDeprecated).toBe(true)
	expect(pluckPlacetypeSpec(baseProps({ "edtf:cessation": "2020" })).isCeased).toBe(true)
	expect(pluckPlacetypeSpec(baseProps({ "wof:superseded_by": [202] })).isSuperseded).toBe(true)
	expect(pluckPlacetypeSpec(baseProps({ "wof:supersedes": [303] })).isSuperseding).toBe(true)
	const clean = pluckPlacetypeSpec(baseProps())
	expect([clean.isDeprecated, clean.isCeased, clean.isSuperseded, clean.isSuperseding]).toEqual([
		false,
		false,
		false,
		false,
	])
})

test("pluckPlacetypeSpec: builds the localized name map from name:<lang>_x_<kind> keys", () => {
	const spec = pluckPlacetypeSpec(
		baseProps({ "name:eng_x_preferred": "London", "name:fra_x_preferred": "Londres" } as Partial<WOFProperties>)
	)
	expect(spec.localizedPropMap.get("eng" as never)?.get("preferred")).toBe("London")
	expect(spec.localizedPropMap.get("fra" as never)?.get("preferred")).toBe("Londres")
})

test("pluckFileNameLanguageCode: normalizes a WOF name file to an alpha-2 code; null when unrecognized", () => {
	expect(pluckFileNameLanguageCode("name:eng_x_preferred.txt")).toBe("en") // alpha-3 → alpha-2
	expect(pluckFileNameLanguageCode("not-a-name-file.json")).toBeNull()
})
