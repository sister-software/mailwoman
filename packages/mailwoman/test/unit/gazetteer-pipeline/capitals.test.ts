/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The capitals-reference build (#1880) — the exact-code admission rule (`PPLA` in, `PPLA2`/`PPLCH` out), the
 *   coverage grading against the catalog's own capital names, and the wrong-format classification that keeps a postal
 *   export squatting on `<CC>.txt` from reading as "scanned, no capital".
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
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

		expect(rows.map((r) => [r.entry.id, r.entry.level])).toEqual([
			[1, "national"],
			[2, "admin1"],
		])
	})

	it("folds name, asciiname, and alternate names for the catalog cross-check", () => {
		const [row] = parseCapitalRows(dumpRow(7, "San José", "P", "PPLC", "CR", "San Jose,Chepe"))

		expect(row!.foldedNames.has("san jose")).toBe(true)
		expect(row!.foldedNames.has("chepe")).toBe(true)
	})

	it("rounds coordinates to 4 decimals — the committed file matches at km radius, not survey precision", () => {
		const [row] = parseCapitalRows(dumpRow(8, "Capital City", "P", "PPLC", "AA"))

		expect(row!.entry.latitude).toBe(9.9333)
		expect(row!.entry.longitude).toBe(-84.0833)
	})
})

describe("buildCapitalsReference", () => {
	it("grades coverage against the catalog: wrong-format files are named, never counted as scanned", () => {
		const dir = mkdtempSync(join(tmpdir(), "mw-capitals-"))

		writeFileSync(
			join(dir, "countryInfo.txt"),
			[
				"# commentary",
				"AA\tAAA\t004\tAF\tAaland\tCapital City\t1\t1\tAS\t.aa",
				"BB\tBBB\t008\tAL\tBebland\tBe City\t1\t1\tEU\t.bb",
				"CC\tCCC\t012\tDZ\tCeland\tCe City\t1\t1\tAF\t.cc",
			].join("\n")
		)

		// AA: a real dump whose PPLC name disagrees with the catalog. BB: a postal export on the dump filename.
		// CC: no file at all.
		writeFileSync(join(dir, "AA.txt"), dumpRow(1, "Other Name", "P", "PPLC", "AA"))
		writeFileSync(join(dir, "BB.txt"), ["BB", "1000", "Be City", "", "", "", "", "", "", "1.0", "2.0", "6"].join("\t"))

		const outPath = join(dir, "capitals.json")
		const { coverage } = buildCapitalsReference({ geonamesDir: dir, outPath })

		expect(coverage.countries_scanned).toBe(1)
		expect(coverage.wrong_format).toEqual(["BB"])
		expect(coverage.missing_dumps).toEqual(["CC"])
		expect(coverage.capital_name_mismatches).toEqual(['AA: catalog says "Capital City"'])

		const written = parseJSONStrict<CapitalsReference>(readFileSync(outPath, "utf8"))

		expect(written.version).toBe(1)

		expect(written.entries).toEqual([
			{ id: 1, name: "Other Name", country: "AA", latitude: 9.9333, longitude: -84.0833, level: "national" },
		])
	})

	it("throws without countryInfo.txt — no catalog, no coverage denominator", () => {
		const dir = mkdtempSync(join(tmpdir(), "mw-capitals-"))

		expect(() => buildCapitalsReference({ geonamesDir: dir, outPath: join(dir, "out.json") })).toThrow(/countryInfo/)
	})
})
