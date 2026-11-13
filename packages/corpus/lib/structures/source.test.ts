// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { getPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import { describe, expect, it } from "vitest"

import { postOfficeCategoryID } from "#structures/source"

describe("postOfficeCategoryID", () => {
	it("resolves to the taxonomy category whose OSM tag is a post office", () => {
		expect(getPOICategory(postOfficeCategoryID())?.osmTag).toBe("amenity=post_office")
	})
})
