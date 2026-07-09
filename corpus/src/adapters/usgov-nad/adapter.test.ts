/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import type { CanonicalRow } from "../../types.ts"
import { createUsgovNADAdapter, USGOV_NAD_ADAPTER_ID, USGOV_NAD_DEFAULT_LICENSE } from "./adapter.ts"

const FIXTURE_DIR = repoRootPath("corpus", "src", "adapters", "usgov-nad", "fixtures")

async function collect(adapter = createUsgovNADAdapter(), opts: { country?: string; limit?: number } = {}) {
	const out: CanonicalRow[] = []

	for await (const row of adapter.rows({ inputPath: FIXTURE_DIR, ...opts })) {
		out.push(row)
	}

	return out
}

describe("usgov-nad adapter", () => {
	it("yields the expected count from the fixture (drops 3 invalid rows)", async () => {
		// fixture.ndjson has 12 rows: 9 valid, 3 dropped (empty Post_City, bad state ZZ, empty Zip_Code).
		const rows = await collect()
		expect(rows.length).toBe(9)
	})

	it("composes a 4-component address with venue when LandmkName is set", async () => {
		const rows = await collect()
		const wh = rows.find((r) => r.components.venue === "The White House")
		expect(wh).toBeDefined()
		expect(wh!.components.locality).toBe("Washington")
		expect(wh!.components.region).toBe("DC")
		expect(wh!.components.postcode).toBe("20500")
		// Stage 3 decomposition: NAD's structured St_PreDir/St_Name/St_PosTyp/St_PosDir
		// become street_prefix/street/street_suffix. Pennsylvania Avenue NW has no prefix —
		// "Avenue" is St_PosTyp and "NW" is St_PosDir, both → street_suffix.
		expect(wh!.components.street).toBe("Pennsylvania")
		expect(wh!.components.street_suffix).toBe("Avenue NW")
		expect(wh!.components.house_number).toBe("1600")
		expect(wh!.raw).toBe("The White House, 1600 Pennsylvania Avenue NW, Washington, DC 20500")
	})

	it("joins Zip_Code + Plus_4 into ZIP+4 form when both present", async () => {
		const rows = await collect()
		const oregon = rows.find((r) => r.components.locality === "Springfield")
		expect(oregon).toBeDefined()
		expect(oregon!.components.postcode).toBe("97477-1234")
		expect(oregon!.components.region).toBe("OR")
	})

	it("yields venue-only rows when no street parts are present", async () => {
		const rows = await collect()
		const ynp = rows.find((r) => r.components.venue === "Yellowstone National Park")
		expect(ynp).toBeDefined()
		expect(ynp!.components.house_number).toBeUndefined()
		expect(ynp!.components.street).toBeUndefined()
		expect(ynp!.components.locality).toBe("Yellowstone National Park")
		expect(ynp!.components.region).toBe("WY")
	})

	it("handles hyphenated NYC house numbers verbatim (40-12 Bell Blvd)", async () => {
		const rows = await collect()
		const nyc = rows.find((r) => r.components.house_number === "40-12")
		expect(nyc).toBeDefined()
		expect(nyc!.components.street).toBe("Bell")
		expect(nyc!.components.street_suffix).toBe("Blvd")
		expect(nyc!.components.locality).toBe("Bayside")
	})

	it("falls back to AddNum_Pre+Add_Number+AddNum_Suf when AddNo_Full is null", async () => {
		const rows = await collect()
		const vt = rows.find((r) => r.components.region === "VT")
		expect(vt).toBeDefined()
		expect(vt!.components.house_number).toBe("99 B")
	})

	it("decomposes St_PreDir + St_Name + St_PosTyp into Stage 3 components", async () => {
		const rows = await collect()
		const vt = rows.find((r) => r.components.region === "VT")
		expect(vt).toBeDefined()
		expect(vt!.components.street_prefix).toBe("N")
		expect(vt!.components.street).toBe("Maple")
		expect(vt!.components.street_suffix).toBe("St")
	})

	it("accepts PR territory", async () => {
		const rows = await collect()
		const pr = rows.find((r) => r.components.region === "PR")
		expect(pr).toBeDefined()
		expect(pr!.components.postcode).toBe("00901")
		expect(pr!.components.locality).toBe("San Juan")
	})

	it("rejects unknown state codes (ZZ)", async () => {
		const rows = await collect()
		expect(rows.find((r) => r.components.region === "ZZ")).toBeUndefined()
	})

	it("rejects rows with empty Zip_Code", async () => {
		const rows = await collect()
		// The CA row with Post_City="Anywhere" + empty Zip → dropped
		expect(rows.find((r) => r.components.locality === "Anywhere" && r.components.region === "CA")).toBeUndefined()
	})

	it("rejects rows with empty Post_City", async () => {
		const rows = await collect()
		// The NY row with empty Post_City + valid Zip 10001 → dropped (no locality alternates either)
		expect(rows.filter((r) => r.components.region === "NY" && r.components.postcode === "10001")).toHaveLength(0)
	})

	it("stamps source, locale, country, license consistently", async () => {
		const rows = await collect()

		for (const r of rows) {
			expect(r.source).toBe(USGOV_NAD_ADAPTER_ID)
			expect(r.country).toBe("US")
			expect(r.locale).toBe("en-US")
			expect(r.license).toBe(USGOV_NAD_DEFAULT_LICENSE)
			expect(r.source_id).toMatch(/^usgov-nad-/)
		}
	})

	it("honors opts.limit (soft cap)", async () => {
		const rows = await collect(undefined, { limit: 3 })
		expect(rows.length).toBe(3)
	})

	it("rejects non-US country filter", async () => {
		const adapter = createUsgovNADAdapter()
		const iterate = async () => {
			for await (const _ of adapter.rows({ inputPath: FIXTURE_DIR, country: "FR" })) {
				/* should throw before first yield */
			}
		}
		await expect(iterate()).rejects.toThrow(/only US supported/)
	})
})
