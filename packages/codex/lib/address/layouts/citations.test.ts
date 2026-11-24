// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { layoutForCountry, uncitedLayoutJurisdictions } from "#address/layouts"
import { LAYOUT_CITATIONS } from "#address/layouts/citations"
import { UPU_PAS_LAYOUT_RECORDS } from "#address/layouts/description-records"
import { UPU_PAS_ADDRESS_LAYOUTS } from "#address/layouts/upu-pas"

const citations = [...Object.entries(LAYOUT_CITATIONS), ...Object.entries(UPU_PAS_LAYOUT_RECORDS)]

describe("layout citations", () => {
	it("names a document a reader can retrieve and compare", () => {
		for (const [code, citation] of citations) {
			expect(citation.url, code).toMatch(/^https:\/\//u)
			expect(citation.documentDate, code).toMatch(/^\d{4}-\d{1,2}$/u)
			expect(citation.retrievedAt, code).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
			expect(citation.sha256, code).toMatch(/^[0-9a-f]{64}$/u)
			expect(citation.examples.length, code).toBeGreaterThan(0)
			expect(citation.unexpressed.length, code).toBeGreaterThan(0)

			for (const example of citation.examples) {
				expect(example.length, code).toBeGreaterThan(0)

				expect(
					example.every((line) => line.trim() === line && line.length > 0),
					code
				).toBe(true)
			}
		}
	})

	it("cites a layout the jurisdiction renders, once", () => {
		const uncited = new Set(uncitedLayoutJurisdictions())

		for (const [code] of citations) {
			expect(layoutForCountry(code), code).not.toBeNull()
			expect(uncited.has(code), code).toBe(false)
		}

		for (const code of Object.keys(LAYOUT_CITATIONS)) {
			expect(UPU_PAS_ADDRESS_LAYOUTS[code], code).toBeUndefined()
		}
	})
})
