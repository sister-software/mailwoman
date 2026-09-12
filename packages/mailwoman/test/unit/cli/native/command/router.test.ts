import { optionPropertyName } from "mailwoman/cli-native/command-router"
import { describe, expect, it } from "vitest"

describe("optionPropertyName", () => {
	it.each([
		["transition-beta", "transitionBeta"],
		["borough-db", "boroughDB"],
		["postcode-locality-db", "postcodeLocalityDB"],
		["db", "db"],
	])("maps --%s to options.%s", (flag, property) => {
		expect(optionPropertyName(flag)).toBe(property)
	})

	// An acronym segment the derivation does not know title-cases instead, and the flag then fills a property no
	// command declares: it parses, it validates, and it does nothing. Each row below is a flag a command ships.
	it.each([
		["out-json", "outJSON"],
		["errors-json", "errorsJSON"],
		["out-jsonl", "outJSONL"],
		["out-html", "outHTML"],
		["out-svg", "outSVG"],
		["oa-csv", "oaCSV"],
		["postal-xml", "postalXML"],
		["radius-km", "radiusKM"],
		["include-location-ids", "includeLocationIDs"],
	])("capitalizes the whole acronym: --%s to options.%s", (flag, property) => {
		expect(optionPropertyName(flag)).toBe(property)
	})
})
