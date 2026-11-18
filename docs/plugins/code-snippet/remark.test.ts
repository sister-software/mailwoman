// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { snippetReference } from "./remark.ts"

describe("snippetReference", () => {
	test("reads the file attribute and keeps the rest of the info string", () => {
		expect(snippetReference("file=./start.snippet.mts title=parse.ts")).toEqual({
			path: "./start.snippet.mts",
			meta: "title=parse.ts",
		})

		expect(snippetReference("file=../a.snippet.ts")).toEqual({ path: "../a.snippet.ts", meta: null })
	})

	test("returns null for a fence without the attribute", () => {
		expect(snippetReference("title=parse.ts")).toBeNull()
		expect(snippetReference(null)).toBeNull()
	})
})
