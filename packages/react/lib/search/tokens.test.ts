// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { queryTokens } from "#search/tokens"

test("splits the text into runs of letters and digits, as the index tokenizer does", () => {
	expect(queryTokens('  tier-1  "regression" -- *** ')).toEqual(["tier", "1", "regression"])
	expect(queryTokens("Zürich straße")).toEqual(["Zürich", "straße"])
	expect(queryTokens("-- ***")).toEqual([])
})
