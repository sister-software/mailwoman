/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	createStateHiSchoolsAdapter,
	STATE_HI_SCHOOLS_ADAPTER_ID,
	STATE_HI_SCHOOLS_DEFAULT_LICENSE,
} from "@mailwoman/corpus/adapters/state-hi-schools/adapter"
import { join, type PathBuilderLike } from "path-ts"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import writeXlsxFile, { type SheetData } from "write-excel-file/node"

import { InMemoryAdapterRegistry } from "#adapters/utils"
import { writeDelimitedFixture } from "#test-kit"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const SCHOOL_HEADER = [
	"code",
	"name",
	"address",
	"city",
	"zip",
	"phone",
	"fax",
	"principal",
	"grade_from",
	"grade_to",
	"type",
	"website",
	"complex",
	"complex_area",
	"district",
	"island",
	"charter",
]

const CSV_HEADER = SCHOOL_HEADER.join(",")

let scratch: PathBuilderLike

beforeEach(async () => {
	scratch = fixtures.use(await temporaryDirectory("mailwoman-hi-schools-")).path
})

function writeCSV(...lines: string[]): Promise<string> {
	return writeDelimitedFixture(join(scratch, "test.csv"), CSV_HEADER, lines)
}

async function writeWorkbook(): Promise<string> {
	const path = join(scratch, "test.xlsx")
	const sheet = (rows: Array<Array<string | number | boolean | null>>): SheetData => rows as SheetData

	await writeXlsxFile([
		{
			sheet: "HIDOE",
			data: sheet([SCHOOL_HEADER, [335, "Ahuimanu Elem School", "47-470 Hui Aeko Place", "Kaneohe", 96_744]]),
		},
		{
			sheet: "PCS",
			data: sheet([SCHOOL_HEADER, [901, "Voyager Public Charter School", "2428 Wilder Avenue", "Honolulu", 96_822]]),
		},
	]).toFile(path)

	return path
}

describe("state-hi-schools adapter", () => {
	it("has the expected id and license", () => {
		const a = createStateHiSchoolsAdapter()
		expect(a.id).toBe(STATE_HI_SCHOOLS_ADAPTER_ID)
		expect(a.defaultLicense).toBe(STATE_HI_SCHOOLS_DEFAULT_LICENSE)
	})

	it("emits a row for a HIDOE school with a hyphenated Oahu address", async () => {
		const p = await writeCSV(
			"335,Ahuimanu Elem School,47-470 Hui Aeko Place,Kaneohe,96744,808.305.4800,808.239.3127,Kimi Ikeda,K,6,Elementary,http://example,Castle,Castle-Kahuku,Windward,Oahu,False"
		)

		const a = createStateHiSchoolsAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 5 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(1)
		const r = rows[0]!
		expect(r.country).toBe("US")
		expect(r.locale).toBe("en-US")
		expect(r.source).toBe(STATE_HI_SCHOOLS_ADAPTER_ID)
		expect(r.source_id).toBe(`${STATE_HI_SCHOOLS_ADAPTER_ID}-335`)
		expect(r.license).toBe(STATE_HI_SCHOOLS_DEFAULT_LICENSE)
		expect(r.components.venue).toBe("Ahuimanu Elem School")
		expect(r.components.house_number).toBe("47-470")
		expect(r.components.street).toContain("Hui Aeko Place")
		expect(r.components.locality).toBe("Kaneohe")
		expect(r.components.region).toBe("HI")
		expect(r.components.postcode).toBe("96744")
	})

	it("reads HIDOE and PCS directly from the typed XLSX workbook", async () => {
		const p = await writeWorkbook()
		const rows = []

		for await (const row of createStateHiSchoolsAdapter().rows({ inputPath: p })) {
			rows.push(row)
		}

		expect(rows).toHaveLength(2)

		expect(rows.map((row) => row.source_id)).toEqual([
			`${STATE_HI_SCHOOLS_ADAPTER_ID}-335`,
			`${STATE_HI_SCHOOLS_ADAPTER_ID}-901`,
		])

		expect(rows.map((row) => row.components.venue)).toEqual(["Ahuimanu Elem School", "Voyager Public Charter School"])
	})

	it("emits a row for a charter (PCS) school with a non-hyphenated address", async () => {
		const p = await writeCSV(
			"540,Halau Ku Mana - PCS,2101 Makiki Heights Drive,Honolulu,96822,808.945.1600,808.945.1604,Lori Pereia,4,12,K - 12,http://example,Roosevelt,Kaimuki-McKinley-Roosevelt,Honolulu,Oahu,True"
		)

		const a = createStateHiSchoolsAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 5 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(1)
		const r = rows[0]!
		expect(r.components.venue).toBe("Halau Ku Mana - PCS")
		expect(r.components.house_number).toBe("2101")
		expect(r.components.street).toContain("Makiki Heights Drive")
		expect(r.components.locality).toBe("Honolulu")
		expect(r.components.region).toBe("HI")
		expect(r.components.postcode).toBe("96822")
		expect(r.source_id).toBe(`${STATE_HI_SCHOOLS_ADAPTER_ID}-540`)
	})

	it("skips rows with missing required fields", async () => {
		const p = await writeCSV(
			// missing name
			",,200 Some Way,Honolulu,96813,,,,,,,,,,,,",
			// missing address
			"999,Bad School,,Honolulu,96813,,,,,,,,,,,,",
			// missing city
			"998,Bad School,200 Some Way,,96813,,,,,,,,,,,,",
			// missing zip
			"997,Bad School,200 Some Way,Honolulu,,,,,,,,,,,,,",
			// good
			"123,Real School,500 Real Street,Honolulu,96813,,,,,,,,,,,,"
		)

		const a = createStateHiSchoolsAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 10 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(1)
		expect(rows[0]!.components.venue).toBe("Real School")
	})

	it("rejects non-US country filter", async () => {
		const a = createStateHiSchoolsAdapter()

		await expect(
			(async () => {
				for await (const _ of a.rows({ inputPath: "/dev/null", country: "FR" }));
			})()
		).rejects.toThrow(/only US supported/)
	})

	it("registers cleanly with an InMemoryAdapterRegistry", () => {
		const registry = new InMemoryAdapterRegistry()
		registry.register(createStateHiSchoolsAdapter())
		expect(registry.get(STATE_HI_SCHOOLS_ADAPTER_ID)?.id).toBe(STATE_HI_SCHOOLS_ADAPTER_ID)
	})

	it("honors limit", async () => {
		const p = await writeCSV(
			"100,A School,100 A St,Honolulu,96813,,,,,,,,,,,,",
			"101,B School,200 B St,Honolulu,96813,,,,,,,,,,,,",
			"102,C School,300 C St,Honolulu,96813,,,,,,,,,,,,"
		)

		const a = createStateHiSchoolsAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 2 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(2)
	})
})
