/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { queryTokens } from "#search/tokens"

test("splits the text into runs of letters and digits, as the index tokenizer does", () => {
	expect(queryTokens('  tier-1  "regression" -- *** ')).toEqual(["tier", "1", "regression"])
	expect(queryTokens("Zürich straße")).toEqual(["Zürich", "straße"])
	expect(queryTokens("-- ***")).toEqual([])
})
