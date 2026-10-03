import { describe, expect, it } from "vitest"

import { newestXLSXResource } from "#ro/tools/fetch/retea-scolara"

describe("newestXLSXResource", () => {
	it("picks the XLSX with the latest date and ignores other formats", () => {
		const picked = newestXLSXResource([
			{ url: "a.xlsx", format: "XLSX", last_modified: "2024-10-01T00:00:00" },
			{ url: "b.csv", format: "CSV", last_modified: "2026-01-01T00:00:00" },
			{ url: "c.xlsx", format: "xlsx", created: "2025-10-08T13:22:57" },
		])

		expect(picked.url).toBe("c.xlsx")
	})

	it("refuses a dataset with no XLSX", () => {
		expect(() => newestXLSXResource([{ url: "b.csv", format: "CSV" }])).toThrow(/no XLSX/u)
	})
})
