// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { readParquetRows } from "#parquet/readers"
import { convertNADToParquet } from "#us/tools/fetch/nad/parquet"

const HEADER = "UUID,State,County,Add_Number,StNam_Full,Zip_Code"

const ROWS = [
	"c,WI,Sheboygan County,3971,Sunny Slope Ave,53011",
	"a,MI,Wayne County,1,Woodward Ave,48201",
	"b,WI,Sheboygan County,145,Pleasant View Ave,53011",
	"d,AK,Aleutians East Borough,1000,Sand Point Avenue,",
]

describe("convertNADToParquet", () => {
	it("sorts by state, county and UUID, keeps every value as text, and counts rows by state", async () => {
		await using directory = await temporaryDirectory("nad-parquet-")
		const textPath = directory.path("NAD.txt")
		const parquetPath = directory.path("nad.parquet")

		await writeLocalTextFile([HEADER, ...ROWS].join("\n"), textPath)

		const { record, converted } = await convertNADToParquet({
			textPath,
			parquetPath,
			sourceSHA256: "abc",
			member: "NAD.txt",
		})

		expect(converted).toBe(true)
		expect(record).toMatchObject({ rows: 4, rowsByState: { AK: 1, MI: 1, WI: 2 } })

		const rows = await readParquetRows<{ UUID: string; Zip_Code: string | null }>(parquetPath)

		expect(rows.map(({ UUID }) => UUID)).toEqual(["d", "a", "b", "c"])
		expect(rows[1]!.Zip_Code).toBe("48201")
	})

	it("keeps the Parquet file when its record names the same archive, and converts again for another", async () => {
		await using directory = await temporaryDirectory("nad-parquet-")
		const textPath = directory.path("NAD.txt")
		const parquetPath = directory.path("nad.parquet")

		await writeLocalTextFile([HEADER, ...ROWS].join("\n"), textPath)

		const options = { textPath, parquetPath, sourceSHA256: "abc", member: "NAD.txt" }

		await convertNADToParquet(options)

		expect((await convertNADToParquet(options)).converted).toBe(false)
		expect((await convertNADToParquet({ ...options, sourceSHA256: "def" })).converted).toBe(true)
	})

	it("names the missing sort column", async () => {
		await using directory = await temporaryDirectory("nad-parquet-")
		const textPath = directory.path("NAD.txt")

		await writeLocalTextFile("UUID,County\na,Wayne County", textPath)

		await expect(
			convertNADToParquet({
				textPath,
				parquetPath: directory.path("nad.parquet"),
				sourceSHA256: "abc",
				member: "NAD.txt",
			})
		).rejects.toThrow(/lacks State/u)
	})
})
