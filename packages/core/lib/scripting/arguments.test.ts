/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The argv accessors `@mailwoman/core/scripting/arguments` exports.
 */

import { describe, expect, it } from "vitest"

import * as scriptingUtils from "#scripting/arguments"

describe("@mailwoman/core/scripting/arguments", () => {
	it("exports every argv accessor", () => {
		expect(typeof scriptingUtils.cliArguments, "cliArguments").toBe("function")
		expect(typeof scriptingUtils.optionPropertyName, "optionPropertyName").toBe("function")
		expect(typeof scriptingUtils.passThroughCLIArguments, "passThroughCLIArguments").toBe("function")
		expect(typeof scriptingUtils.scriptEntryPath, "scriptEntryPath").toBe("function")
	})

	it("hands back the argument vector as strings", () => {
		// The verbatim passthrough is spread into a child-process command line, so the element type is the interface.
		for (const argument of scriptingUtils.passThroughCLIArguments()) {
			expect(typeof argument).toBe("string")
		}

		expect(scriptingUtils.passThroughCLIArguments()).toEqual(scriptingUtils.cliArguments())
	})
})

describe("optionPropertyName", () => {
	it.each([
		["transition-beta", "transitionBeta"],
		["borough-db", "boroughDB"],
		["postcode-locality-db", "postcodeLocalityDB"],
		["db", "db"],
	])("maps --%s to options.%s", (flag, property) => {
		expect(scriptingUtils.optionPropertyName(flag)).toBe(property)
	})

	// An acronym segment the derivation does not know title-cases instead,
	// filling a property no command declares.
	// The flag parses and validates, then has no effect.
	// Each row below is a flag a command ships.
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
		expect(scriptingUtils.optionPropertyName(flag)).toBe(property)
	})
})
