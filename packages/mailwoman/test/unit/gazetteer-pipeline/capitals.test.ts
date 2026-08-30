/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The capitals-reference build (#1880) — the exact-code admission rule (`PPLA` in, `PPLA2`/`PPLCH` out), the
 *   coverage grading against the catalog's own capital names, and the wrong-format classification that keeps a postal
 *   export squatting on `<CC>.txt` from reading as "scanned, no capital".
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { join } from "@mailwoman/platform/path"
import { buildCapitalsReference, type CapitalsReference, parseCapitalRows } from "mailwoman/gazetteer-pipeline/capitals"
import { describe, expect, it } from "vitest"

function dumpRow(id: number, name: string, fclass: string, fcode: string, country: string, alternates = ""): string {
	const cols = new Array<string>(19).fill("")

	cols[0] = String(id)
	cols[1] = name
	cols[2] = name
	cols[3] = alternates
	cols[4] = "9.93333"
	cols[5] = "-84.08333"
	cols[6] = fclass
	cols[7] = fcode
	cols[8] = country

	return cols.join("\t")
}

describe("parseCapitalRows", () => {
	it("admits PPLC and PPLA exactly — never the lower-order seats or the historical code", () => {
		const rows = parseCapitalRows(
			[
				dumpRow(1, "Capital City", "P", "PPLC", "AA"),
				dumpRow(2, "Seat City", "P", "PPLA", "AA"),
				dumpRow(3, "County Seat", "P", "PPLA2", "AA"),
				dumpRow(4, "Old Capital", "P", "PPLCH", "AA"),
				dumpRow(5, "Capital Hill", "T", "PPLC", "AA"),
			].join("\n")
		)

		expect(rows.map((r) => [r.id, r.level])).toEqual([
			[1, "national"],
			[2, "admin1"],
		])
	})

	it("folds name, asciiname, and alternate names into the shipped name set", () => {
		const [row] = parseCapitalRows(dumpRow(7, "San José", "P", "PPLC", "CR", "San Jose,Chepe"))

		expect(row!.k).toContain("san jose")
		expect(row!.k).toContain("chepe")
	})

	it("rounds coordinates to 4 decimals — the committed file matches at km radius, not survey precision", () => {
		const [row] = parseCapitalRows(dumpRow(8, "Capital City", "P", "PPLC", "AA"))

		expect(row!.latitude).toBe(9.9333)
		expect(row!.longitude).toBe(-84.0833)
	})
})

describe("buildCapitalsReference", () => {
	it("grades coverage against the catalog: wrong-format files are named, never counted as scanned", async () => {
		await using dirDirectory = await temporaryDirectory("mw-capitals-")
		const dir = dirDirectory.path

		await writeLocalTextFile(
			[
				"# commentary",
				"AA\tAAA\t004\tAF\tAaland\tCapital City\t1\t1\tAS\t.aa",
				"BB\tBBB\t008\tAL\tBebland\tBe City\t1\t1\tEU\t.bb",
				"CC\tCCC\t012\tDZ\tCeland\tCe City\t1\t1\tAF\t.cc",
			].join("\n"),
			join(dir, "countryInfo.txt")
		)

		// AA: a real dump whose PPLC name disagrees with the catalog. BB: a postal export on the dump filename.
		// CC: no file at all.
		await writeLocalFile(dumpRow(1, "Other Name", "P", "PPLC", "AA"), join(dir, "AA.txt"))

		await writeLocalTextFile(
			["BB", "1000", "Be City", "", "", "", "", "", "", "1.0", "2.0", "6"].join("\t"),
			join(dir, "BB.txt")
		)

		const outPath = join(dir, "capitals.json")
		const { coverage } = await buildCapitalsReference({ geonamesDir: dir, outPath })

		expect(coverage.countries_scanned).toBe(1)
		expect(coverage.wrong_format).toEqual(["BB"])
		expect(coverage.missing_dumps).toEqual(["CC"])
		expect(coverage.capital_name_mismatches).toEqual(['AA: catalog says "Capital City"'])

		const written = await readLocalJSONFile<CapitalsReference>(outPath)

		expect(written.version).toBe(1)

		expect(written.entries).toEqual([
			{
				id: 1,
				name: "Other Name",
				country: "AA",
				latitude: 9.9333,
				longitude: -84.0833,
				level: "national",
				k: ["other name"],
			},
		])
	})

	it("throws without countryInfo.txt — no catalog, no coverage denominator", async () => {
		await using dirDirectory = await temporaryDirectory("mw-capitals-")
		const dir = dirDirectory.path

		await expect(buildCapitalsReference({ geonamesDir: dir, outPath: join(dir, "out.json") })).rejects.toThrow(
			/countryInfo/
		)
	})
})
