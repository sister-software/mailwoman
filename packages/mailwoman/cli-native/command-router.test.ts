import { describe, expect, it } from "vitest"

import { optionPropertyName } from "./command-router.ts"

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
