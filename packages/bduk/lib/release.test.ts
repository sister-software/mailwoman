/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture `test/fixtures/202605_BDUK_uprn_release_sample.csv` copies eight rows verbatim from the
 *   published Building Digital UK sample file for the May 2026 release, retrieved 2026-10-05 under
 *   OGL v3.0. It keeps the sample's published file name and header. The sample's rows are all
 *   `Gigabit Grey/Black`, so the tests that read the other statuses replace one cell.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { TextSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

import {
	BDUKColumnError,
	BDUKSubsidyControlStatus,
	BDUKValueError,
	parseBDUKRelease,
	parseBDUKReleaseFileName,
	readBDUKReleaseDirectory,
	readBDUKReleaseFile,
} from "#release"

const SAMPLE = "202605_BDUK_uprn_release_sample.csv"
const LONDON_CROYDON = "202605_BDUK_uprn_release_london_croydon.csv"

/**
 * The fixture's text as published: LF line ends and no byte-order mark.
 */
function readFixture(): Promise<string> {
	return readLocalTextFile(workspacePath("bduk", "test", "fixtures", SAMPLE))
}

function linesOf(text: string): string[] {
	return TextSpliterator.from(text).toArray()
}

/**
 * The fixture text with one cell replaced.
 *
 * Only line 9 quotes a field, so a comma split is exact on lines 1 to 8.
 */
function withCell(text: string, line: number, column: string, value: string): string {
	const lines = linesOf(text)
	const index = lines[0]!.split(",").indexOf(column)
	const cells = lines[line - 1]!.split(",")

	if (index === -1) throw new Error(`the fixture has no column ${column}`)

	cells[index] = value
	lines[line - 1] = cells.join(",")

	return `${lines.join("\n")}\n`
}

describe("parseBDUKReleaseFileName", () => {
	test("reads the OMR month and the name's part from each published name", () => {
		expect(parseBDUKReleaseFileName(LONDON_CROYDON)).toEqual({
			file: LONDON_CROYDON,
			release: "2026-05",
			part: "london_croydon",
		})

		expect(parseBDUKReleaseFileName(SAMPLE)).toEqual({ file: SAMPLE, release: "2026-05", part: "sample" })

		expect(
			parseBDUKReleaseFileName("202605_BDUK_uprn_release_no_region_no_local_authority_district.csv")
		).toMatchObject({ part: "no_region_no_local_authority_district" })
	})

	test("refuses a name that states no OMR month", () => {
		expect(() => parseBDUKReleaseFileName("croydon.csv")).toThrow(/not a BDUK UPRN-level release file name/)
		expect(() => parseBDUKReleaseFileName("202613_BDUK_uprn_release_london_croydon.csv")).toThrow(/not a BDUK/)
	})
})

describe("readBDUKReleaseFile", () => {
	test("returns the requested columns of every row, typed, in file order", async () => {
		const { source, rowCount, rows } = await readBDUKReleaseFile(workspacePath("bduk", "test", "fixtures", SAMPLE), [
			"postcode",
			"subsidy_control_status",
			"current_gigabit",
			"future_gigabit",
			"bduk_recognised_premises",
		])

		expect(source).toEqual({ file: SAMPLE, release: "2026-05", part: "sample" })
		expect(rowCount).toBe(8)

		expect(rows.map((row) => row.uprn)).toEqual([
			44_010_201, 44_103_962, 100_120_036_482, 100_032_176_148, 200_000_073_097, 100_022_933_947, 100_050_095_649,
			200_001_855_695,
		])

		expect(rows[0]).toEqual({
			uprn: 44_010_201,
			file: SAMPLE,
			line: 2,
			values: {
				postcode: "ME1 3HX",
				subsidy_control_status: BDUKSubsidyControlStatus.GreyBlack,
				current_gigabit: true,
				future_gigabit: false,
				bduk_recognised_premises: true,
			},
		})

		expect(rows[5]?.values).toMatchObject({ current_gigabit: false, bduk_recognised_premises: false })
		expect(rows[6]?.values).toMatchObject({ current_gigabit: false, future_gigabit: true })
	})

	test("reads a quoted contract name with its commas, a whole number, a date and the country", async () => {
		const { rows } = parseBDUKRelease(await readFixture(), SAMPLE, [
			"country",
			"lot_id",
			"lot_name",
			"bduk_gis",
			"bduk_gis_contract_scope",
			"bduk_gis_final_coverage_date",
			"bduk_gis_contract_name",
			"bduk_gis_supplier",
		])

		expect(rows[7]).toEqual({
			uprn: 200_001_855_695,
			file: SAMPLE,
			line: 9,
			values: {
				country: "Wales",
				lot_id: 42,
				lot_name: "Wales (North)",
				bduk_gis: true,
				bduk_gis_contract_scope: "Initial",
				bduk_gis_final_coverage_date: "2031-09-30",
				bduk_gis_contract_name: "CO3 North Herefordshire, North Wales, Shropshire and South West Wales",
				bduk_gis_supplier: "Openreach Limited",
			},
		})
	})

	test("reads an empty cell as null, apart from false and from zero", async () => {
		const text = await readFixture()
		const { rows } = parseBDUKRelease(text, SAMPLE, ["bduk_gis", "bduk_gis_contract_scope", "bduk_hubs_supplier"])

		expect(rows[0]?.values).toEqual({ bduk_gis: false, bduk_gis_contract_scope: null, bduk_hubs_supplier: null })

		const blanked = withCell(withCell(text, 2, "current_gigabit", ""), 2, "lot_id", "")
		const [first] = parseBDUKRelease(blanked, SAMPLE, ["current_gigabit", "lot_id", "country"]).rows

		expect(first?.values).toEqual({ current_gigabit: null, lot_id: null, country: "England" })

		const zero = parseBDUKRelease(withCell(text, 2, "lot_id", "0"), SAMPLE, ["lot_id"]).rows[0]

		expect(zero?.values.lot_id).toBe(0)
	})

	test("keeps only the rows of the requested postcodes and still counts every row", async () => {
		const { rowCount, rows } = parseBDUKRelease(await readFixture(), SAMPLE, ["current_gigabit"], {
			postcodes: ["EC2Y 8DQ", "EC2N 2JJ", "N1 9FS"],
		})

		expect(rowCount).toBe(8)

		expect(rows.map((row) => [row.uprn, row.line, row.values.current_gigabit])).toEqual([
			[200_000_073_097, 6, true],
			[100_022_933_947, 7, false],
		])
	})
})

describe("parseBDUKRelease vocabularies", () => {
	test("reads each subsidy control status the May 2026 release writes", async () => {
		const text = await readFixture()

		const statuses = Object.values(BDUKSubsidyControlStatus).map(
			(status) =>
				parseBDUKRelease(withCell(text, 2, "subsidy_control_status", status), SAMPLE, ["subsidy_control_status"])
					.rows[0]?.values.subsidy_control_status
		)

		expect(statuses).toEqual(["Gigabit Grey/Black", "Gigabit White", "Gigabit Under Review"])
	})

	test("a status outside the vocabulary throws with the value, its line and its UPRN", async () => {
		const broken = withCell(await readFixture(), 3, "subsidy_control_status", "Unassessed")

		const error = (() => {
			try {
				parseBDUKRelease(broken, SAMPLE, ["subsidy_control_status"])
			} catch (caught) {
				return caught
			}

			return null
		})()

		expect(error).toBeInstanceOf(BDUKValueError)

		expect(error).toMatchObject({
			file: SAMPLE,
			line: 3,
			uprn: "44103962",
			column: "subsidy_control_status",
			value: "Unassessed",
		})

		expect((error as Error).message).toBe(
			`${SAMPLE} line 3, UPRN 44103962: "subsidy_control_status" holds "Unassessed", which is not one of "Gigabit Grey/Black", "Gigabit White", "Gigabit Under Review".`
		)
	})

	test("a flag reads only true and false, as the release writes them", async () => {
		const text = await readFixture()

		expect(() => parseBDUKRelease(withCell(text, 4, "current_gigabit", "TRUE"), SAMPLE, ["current_gigabit"])).toThrow(
			`${SAMPLE} line 4, UPRN 100120036482: "current_gigabit" holds "TRUE", which is not "true" or "false".`
		)
	})

	test("a contract scope reads Initial and Deferred and refuses the guide's lowercase example", async () => {
		const text = await readFixture()

		const deferred = parseBDUKRelease(withCell(text, 5, "bduk_gis_contract_scope", "Deferred"), SAMPLE, [
			"bduk_gis_contract_scope",
		]).rows[3]

		expect(deferred?.values.bduk_gis_contract_scope).toBe("Deferred")

		expect(() =>
			parseBDUKRelease(withCell(text, 5, "bduk_gis_contract_scope", "deferred"), SAMPLE, ["bduk_gis_contract_scope"])
		).toThrow(/"bduk_gis_contract_scope" holds "deferred", which is not one of "Initial", "Deferred"/)
	})

	test("a country, a whole number and a date outside their forms throw", async () => {
		const text = await readFixture()

		expect(() => parseBDUKRelease(withCell(text, 2, "country", "Scotland"), SAMPLE, ["country"])).toThrow(
			/"country" holds "Scotland", which is not one of "England", "Wales"/
		)

		expect(() => parseBDUKRelease(withCell(text, 2, "lot_id", "29a"), SAMPLE, ["lot_id"])).toThrow(
			/"lot_id" holds "29a", which is not a whole number/
		)

		expect(() =>
			parseBDUKRelease(withCell(text, 5, "bduk_gis_final_coverage_date", "31/03/2032"), SAMPLE, [
				"bduk_gis_final_coverage_date",
			])
		).toThrow(/"bduk_gis_final_coverage_date" holds "31\/03\/2032", which is not a date written YYYY-MM-DD/)
	})

	test("an unrequested column is not read", async () => {
		const altered = withCell(await readFixture(), 2, "subsidy_control_status", "Unassessed")
		const { rows } = parseBDUKRelease(altered, SAMPLE, ["postcode"])

		expect(rows[0]?.values).toEqual({ postcode: "ME1 3HX" })
	})
})

describe("parseBDUKRelease refusals", () => {
	test("a requested column the header lacks throws with the column's name", async () => {
		const renamed = (await readFixture()).replace("current_gigabit", "current_gigabit_2026")

		const error = (() => {
			try {
				parseBDUKRelease(renamed, SAMPLE, ["postcode", "current_gigabit", "future_gigabit"])
			} catch (caught) {
				return caught
			}

			return null
		})()

		expect(error).toBeInstanceOf(BDUKColumnError)
		expect(error).toMatchObject({ file: SAMPLE, columns: ["current_gigabit"] })
		expect((error as Error).message).toBe(`${SAMPLE} has no column for "current_gigabit".`)
	})

	test("a postcode selection needs the postcode column, and every row needs the uprn column", async () => {
		const text = await readFixture()

		expect(() =>
			parseBDUKRelease(text.replace(",postcode,", ",post_code,"), SAMPLE, ["current_gigabit"], {
				postcodes: ["ME1 3HX"],
			})
		).toThrow(`${SAMPLE} has no column for "postcode".`)

		expect(() => parseBDUKRelease(text.replace("uprn,", "id,"), SAMPLE, ["postcode"])).toThrow(
			`${SAMPLE} has no column for "uprn".`
		)
	})

	test("an empty or malformed UPRN throws", async () => {
		const text = await readFixture()

		expect(() => parseBDUKRelease(withCell(text, 3, "uprn", ""), SAMPLE, ["postcode"])).toThrow(
			`${SAMPLE} line 3: "uprn" holds "", which is not a UPRN of 1 to 12 digits.`
		)

		expect(() => parseBDUKRelease(withCell(text, 3, "uprn", "4410396200000"), SAMPLE, ["postcode"])).toThrow(
			/"uprn" holds "4410396200000", which is not a UPRN of 1 to 12 digits/
		)
	})

	test("a repeated UPRN throws with both lines", async () => {
		const lines = linesOf(await readFixture())
		const repeated = `${[...lines, lines[1]!].join("\n")}\n`

		expect(() => parseBDUKRelease(repeated, SAMPLE, ["postcode"])).toThrow(
			`${SAMPLE} line 10 repeats UPRN 44010201 from line 2.`
		)
	})

	test("a row narrower than the header throws", async () => {
		const lines = linesOf(await readFixture())

		lines[2] = lines[2]!.split(",").slice(0, -1).join(",")

		expect(() => parseBDUKRelease(lines.join("\n"), SAMPLE, ["postcode"])).toThrow(
			`${SAMPLE} line 3 has 27 columns where the header has 28.`
		)
	})

	test("an unclosed quote that joins lines throws rather than reading short", async () => {
		const text = await readFixture()

		// A quote opened mid-row joins the next lines into a record wider than the header.
		expect(() => parseBDUKRelease(withCell(text, 4, "lot_name", '"Devon & Somerset'), SAMPLE, ["postcode"])).toThrow(
			`${SAMPLE} line 4 has 9 columns where the header has 28.`
		)

		// A quote opened in the last column keeps the joined record's width, and only the line count shows the loss.
		const unquoted = `${linesOf(text).slice(0, 8).join("\n")}\n`

		expect(() => parseBDUKRelease(withCell(unquoted, 7, "bduk_hubs_supplier", '"'), SAMPLE, ["postcode"])).toThrow(
			`${SAMPLE}: read 6 records from 7 data lines.`
		)
	})

	test("an empty file, a repeated header label and a name that states no OMR month throw", async () => {
		const text = await readFixture()

		expect(() => parseBDUKRelease("", SAMPLE, ["postcode"])).toThrow(`${SAMPLE} is empty.`)

		expect(() => parseBDUKRelease(text.replace("lot_name", "lot_id"), SAMPLE, ["postcode"])).toThrow(
			`${SAMPLE} repeats the header column "lot_id".`
		)

		expect(() => parseBDUKRelease(text, "sample.csv", ["postcode"])).toThrow(/not a BDUK UPRN-level release file name/)
	})
})

describe("readBDUKReleaseDirectory", () => {
	/**
	 * Splits the fixture's rows between two files that take a region's file names.
	 */
	async function regionDirectory(text: string) {
		const scratch = await temporaryDirectory("bduk-release-")
		const [header, ...rows] = linesOf(text)

		await writeLocalTextFile(`${[header, ...rows.slice(0, 5)].join("\n")}\n`, scratch.path(LONDON_CROYDON))

		await writeLocalTextFile(
			`${[header, ...rows.slice(5)].join("\n")}\n`,
			scratch.path("202605_BDUK_uprn_release_london_islington.csv")
		)

		return scratch
	}

	test("reads every CSV file of a region in name order and reports each file it read", async () => {
		await using scratch = await regionDirectory(await readFixture())

		const region = await readBDUKReleaseDirectory(scratch.path(), ["current_gigabit"], {
			postcodes: ["ME1 3HX", "LL72 8LJ"],
		})

		expect(region.release).toBe("2026-05")

		expect(region.files).toEqual([
			{ file: LONDON_CROYDON, release: "2026-05", part: "london_croydon", rowCount: 5 },
			{
				file: "202605_BDUK_uprn_release_london_islington.csv",
				release: "2026-05",
				part: "london_islington",
				rowCount: 3,
			},
		])

		expect(region.rowCount).toBe(8)

		expect(region.rows.map((row) => [row.file, row.line, row.uprn])).toEqual([
			[LONDON_CROYDON, 2, 44_010_201],
			["202605_BDUK_uprn_release_london_islington.csv", 4, 200_001_855_695],
		])
	})

	test("a directory with no CSV file throws rather than reading as an empty region", async () => {
		await using scratch = await temporaryDirectory("bduk-release-")

		await expect(readBDUKReleaseDirectory(scratch.path(), ["postcode"])).rejects.toThrow(/holds no CSV file/)
	})

	test("files from two releases, or a selected UPRN in two files, throw", async () => {
		const text = await readFixture()

		await using mixed = await regionDirectory(text)

		await writeLocalTextFile(text, mixed.path("202609_BDUK_uprn_release_london_barnet.csv"))

		await expect(readBDUKReleaseDirectory(mixed.path(), ["postcode"])).rejects.toThrow(
			/mixes releases: 202609_BDUK_uprn_release_london_barnet\.csv is 2026-09 where the other files are 2026-05/
		)

		await using repeated = await regionDirectory(text)

		await writeLocalTextFile(text, repeated.path("202605_BDUK_uprn_release_london_barnet.csv"))

		await expect(readBDUKReleaseDirectory(repeated.path(), ["postcode"], { postcodes: ["ME1 3HX"] })).rejects.toThrow(
			`UPRN 44010201 is in 202605_BDUK_uprn_release_london_barnet.csv line 2 and in ${LONDON_CROYDON} line 2.`
		)
	})
})
