// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import {
	createGeonamesFeaturesAdapter,
	GEONAMES_FEATURES_ADAPTER_ID,
	GEONAMES_FEATURES_PER_CELL,
	GEONAMES_FEATURES_WITH_COUNTRY_DIVISOR,
} from "#adapters/geonames/features/adapter"
import type { CanonicalRow } from "#types"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

let scratch: PathBuilder

beforeEach(async () => {
	scratch = fixtures.use(await temporaryDirectory("mailwoman-geonames-features-")).path
})

/**
 * A 19-column GeoNames main-table row with only the columns the adapter reads filled.
 */
function gnRow(id: string, name: string, featureClass: string, featureCode: string, country: string, admin1 = "") {
	const cols = new Array(19).fill("")
	cols[0] = id
	cols[1] = name
	cols[6] = featureClass
	cols[7] = featureCode
	cols[8] = country
	cols[10] = admin1

	return cols.join("\t")
}

async function run(rows: string[]): Promise<CanonicalRow[]> {
	const input = scratch("allCountries.txt")

	await writeLocalTextFile(rows, input)
	await writeLocalTextFile(["US.CA\tCalifornia\tCalifornia\t5332921"], scratch("admin1CodesASCII.txt"))

	await writeLocalTextFile(
		[
			"# ISO\tISO3\tnum\tfips\tCountry\trest",
			"US\tUSA\t840\tUS\tUnited States\t",
			"MP\tMNP\t580\tCQ\tNorthern Mariana Islands\t",
		],
		scratch("countryInfo.txt")
	)

	return Array.fromAsync(createGeonamesFeaturesAdapter().rows({ inputPath: input }))
}

describe("geonames-features adapter", () => {
	it("labels a physical feature's name as venue, bare and with its region", async () => {
		const rows = await run([
			gnRow("2113272", "Mariana Trench", "U", "TRNU", "MP"),
			gnRow("5383604", "Lake Tahoe", "H", "LK", "US", "CA"),
		])

		expect(rows.filter((row) => !row.source_id.endsWith("-vc")).map((row) => row.raw)).toEqual([
			"Mariana Trench",
			"Lake Tahoe",
			"Lake Tahoe, California",
		])

		const trench = rows.find((row) => row.raw === "Mariana Trench")

		expect(trench?.components).toEqual({ venue: "Mariana Trench" })
		expect(trench?.source_id).toBe(`${GEONAMES_FEATURES_ADAPTER_ID}-2113272-v`)
		expect(trench?.country).toBe("MP")
	})

	it("renders one feature in the divisor with its country, the same features every run", async () => {
		const lakes = Array.from({ length: 400 }, (_, i) => gnRow(String(7_000_000 + i), `Lake ${i}`, "H", `LK${i}`, "US"))
		const first = await run(lakes)
		const withCountry = first.filter((row) => row.source_id.endsWith("-vc"))

		expect(first.filter((row) => row.source_id.endsWith("-v"))).toHaveLength(400)
		expect(withCountry.length).toBeGreaterThan(400 / GEONAMES_FEATURES_WITH_COUNTRY_DIVISOR / 2)
		expect(withCountry.length).toBeLessThan((400 / GEONAMES_FEATURES_WITH_COUNTRY_DIVISOR) * 2)
		expect(withCountry[0]?.components).toEqual({ venue: withCountry[0]!.raw.split(",")[0], country: "United States" })
		expect((await run(lakes)).map((row) => row.source_id)).toEqual(first.map((row) => row.source_id))
	})

	it("reads a directory of country dumps as it reads one dump", async () => {
		await writeLocalTextFile([gnRow("2113272", "Mariana Trench", "U", "TRNU", "MP")], scratch("MP.txt"))
		await writeLocalTextFile([gnRow("5383604", "Lake Tahoe", "H", "LK", "US", "CA")], scratch("US.txt"))
		await writeLocalTextFile(["US.CA\tCalifornia\tCalifornia\t5332921"], scratch("admin1CodesASCII.txt"))

		const rows = await Array.fromAsync(createGeonamesFeaturesAdapter().rows({ inputPath: scratch }))

		expect(rows.filter((row) => !row.raw.includes(",")).map((row) => row.raw)).toEqual(["Mariana Trench", "Lake Tahoe"])
	})

	it("reads only the physical classes, leaving populated places and administrative areas to other sources", async () => {
		const rows = await run([gnRow("1", "Springfield", "P", "PPL", "US"), gnRow("2", "Clark County", "A", "ADM2", "US")])

		expect(rows).toEqual([])
	})

	it("keeps at most the cap of features per country and feature code, choosing the same ones every run", async () => {
		const streams = Array.from({ length: GEONAMES_FEATURES_PER_CELL + 10 }, (_, i) =>
			gnRow(String(9_000_000 + i), `Creek ${i}`, "H", "STM", "US")
		)

		const lake = gnRow("8000000", "Lake One", "H", "LK", "US")

		const first = await run([...streams, lake])
		const bare = (rows: CanonicalRow[]) => rows.filter((row) => !row.raw.includes(","))

		expect(bare(first).filter((row) => row.raw.startsWith("Creek"))).toHaveLength(GEONAMES_FEATURES_PER_CELL)
		expect(bare(first).some((row) => row.raw === "Lake One")).toBe(true)

		const second = await run([...streams, lake])

		expect(second.map((row) => row.source_id)).toEqual(first.map((row) => row.source_id))
	})
})
