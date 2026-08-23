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
})
