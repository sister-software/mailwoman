import { describe, expect, it } from "vitest"

import { bareAdminName } from "#country/bare-admin-names"

describe("bareAdminName", () => {
	it("drops a Japanese ward, city or prefecture suffix", () => {
		expect(bareAdminName("JP", "渋谷区")).toBe("渋谷")
		expect(bareAdminName("JP", "大阪市")).toBe("大阪")
		expect(bareAdminName("JP", "東京都")).toBe("東京")
	})

	it("keeps Hokkaido whole, and refuses a one-character remainder", () => {
		expect(bareAdminName("JP", "北海道")).toBeNull()
		expect(bareAdminName("JP", "港区")).toBeNull()
	})

	it("answers null for a country without a bare form", () => {
		expect(bareAdminName("US", "Brooklyn")).toBeNull()
	})
})
