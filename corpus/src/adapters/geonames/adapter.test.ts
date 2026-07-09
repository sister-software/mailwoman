/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it } from "vitest"

import type { CanonicalRow } from "../../types.ts"
import { createGeonamesAdapter, GEONAMES_ADAPTER_ID, GEONAMES_DEFAULT_LICENSE } from "./adapter.ts"

let scratch: string
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "mailwoman-geonames-"))
})

// Build a 19-column GeoNames main-table row (tab-separated). Only the columns the adapter reads
// need to be meaningful; the rest are padded.
function gnRow(o: {
	id: string
	name: string
	alt?: string
	featureClass: string
	featureCode: string
	country: string
	admin1?: string
}): string {
	const cols = new Array(19).fill("")
	cols[0] = o.id
	cols[1] = o.name
	cols[2] = o.name // asciiname
	cols[3] = o.alt ?? ""
	cols[4] = "44.0" // lat
	cols[5] = "-72.7" // lon
	cols[6] = o.featureClass
	cols[7] = o.featureCode
	cols[8] = o.country
	cols[10] = o.admin1 ?? ""

	return cols.join("\t")
}

function writeFixture(rows: string[], opts?: { admin1?: boolean; countries?: boolean }): string {
	const country = join(scratch, "US.txt")
	writeFileSync(country, rows.join("\n") + "\n", "utf8")

	if (opts?.admin1 !== false) {
		writeFileSync(
			join(scratch, "admin1CodesASCII.txt"),
			["US.VT\tVermont\tVermont\t5242283", "US.CA\tCalifornia\tCalifornia\t5332921"].join("\n") + "\n",
			"utf8"
		)
	}

	if (opts?.countries !== false) {
		writeFileSync(
			join(scratch, "countryInfo.txt"),
			["# ISO\tISO3\tnum\tfips\tCountry\trest", "US\tUSA\t840\tUS\tUnited States\t"].join("\n") + "\n",
			"utf8"
		)
	}

	return country
}

async function collect(inputPath: string, extra?: Record<string, unknown>): Promise<CanonicalRow[]> {
	const out: CanonicalRow[] = []

	for await (const r of createGeonamesAdapter().rows({ inputPath, ...extra })) {
		out.push(r)
	}

	return out
}

describe("geonames adapter", () => {
	it("has the expected id and license", () => {
		const a = createGeonamesAdapter()
		expect(a.id).toBe(GEONAMES_ADAPTER_ID)
		expect(a.defaultLicense).toBe(GEONAMES_DEFAULT_LICENSE)
	})

	it("emits both hierarchy variants for a populated place, with mapped region + country names", async () => {
		const p = writeFixture([
			gnRow({ id: "5234567", name: "Montpelier", featureClass: "P", featureCode: "PPLA", country: "US", admin1: "VT" }),
		])
		const rows = await collect(p)
		expect(rows).toHaveLength(2)
		const byRaw = Object.fromEntries(rows.map((r) => [r.raw, r]))
		expect(byRaw["Montpelier, Vermont"]?.components).toEqual({ locality: "Montpelier", region: "Vermont" })
		expect(byRaw["Montpelier, Vermont, United States"]?.components).toEqual({
			locality: "Montpelier",
			region: "Vermont",
			country: "United States",
		})

		for (const r of rows) {
			expect(r.country).toBe("US")
			expect(r.source).toBe(GEONAMES_ADAPTER_ID)
			expect(r.license).toBe(GEONAMES_DEFAULT_LICENSE)
			expect(r.source_id).toMatch(/^geonames-5234567-(lr|lrc)$/)
		}
	})

	it("skips non-populated-place features and historical/abandoned places", async () => {
		const p = writeFixture([
			gnRow({ id: "1", name: "Mount Mansfield", featureClass: "T", featureCode: "MT", country: "US", admin1: "VT" }), // mountain
			gnRow({ id: "2", name: "Ghost Town", featureClass: "P", featureCode: "PPLQ", country: "US", admin1: "VT" }), // abandoned
			gnRow({ id: "3", name: "Burlington", featureClass: "P", featureCode: "PPL", country: "US", admin1: "VT" }), // real
		])
		const rows = await collect(p)
		expect(rows.every((r) => r.components.locality === "Burlington")).toBe(true)
		expect(rows.length).toBe(2) // only Burlington, two variants
	})

	it("honors the country filter and the row limit", async () => {
		const p = writeFixture([
			gnRow({ id: "10", name: "Burlington", featureClass: "P", featureCode: "PPL", country: "US", admin1: "VT" }),
			gnRow({ id: "11", name: "Toronto", featureClass: "P", featureCode: "PPL", country: "CA", admin1: "08" }),
		])
		expect((await collect(p, { country: "US" })).every((r) => r.country === "US")).toBe(true)
		expect(await collect(p, { limit: 1 })).toHaveLength(1)
	})

	it("degrades gracefully when the region/country name files are absent (locality only)", async () => {
		const p = writeFixture(
			[gnRow({ id: "20", name: "Burlington", featureClass: "P", featureCode: "PPL", country: "US", admin1: "VT" })],
			{ admin1: false, countries: false }
		)
		const rows = await collect(p)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.components).toEqual({ locality: "Burlington" })
		expect(rows[0]?.raw).toBe("Burlington")
	})
})
