// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { countyNameWithoutDesignator } from "#county-designators"

describe("countyNameWithoutDesignator", () => {
	it("removes a covered country's suffix and keeps the written spelling", () => {
		expect(countyNameWithoutDesignator("Harris County", "US")).toBe("Harris")
		expect(countyNameWithoutDesignator("JEFFERSON  PARISH", "us")).toBe("JEFFERSON")
		expect(countyNameWithoutDesignator("Prince of Wales-Hyder Census Area", "US")).toBe("Prince of Wales-Hyder")
	})

	it("removes an Irish prefix, with or without the abbreviation's period", () => {
		expect(countyNameWithoutDesignator("County Cork", "IE")).toBe("Cork")
		expect(countyNameWithoutDesignator("Co. Cork", "IE")).toBe("Cork")
		expect(countyNameWithoutDesignator("Co Cork", "IE")).toBe("Cork")
	})

	it("returns null for a value with no designator, a bare designator, or an uncovered country", () => {
		expect(countyNameWithoutDesignator("Harris", "US")).toBeNull()
		expect(countyNameWithoutDesignator("County", "US")).toBeNull()
		expect(countyNameWithoutDesignator("County Cork", "US")).toBeNull()
		expect(countyNameWithoutDesignator("Harris County", "GB")).toBeNull()
		expect(countyNameWithoutDesignator("Harris County", null)).toBeNull()
	})
})
