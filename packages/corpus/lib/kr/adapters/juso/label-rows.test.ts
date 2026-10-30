/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { expect, test } from "vitest"

import { readJusoLabelRows } from "#kr/adapters/juso/label-rows"

const FIXTURE = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "kr", "juso-fixture.zip.b64")

test("a limit of 0 rows per region emits one row per region, as Python's loop did", async () => {
	await using scratch = await temporaryDirectory("mailwoman-kr-juso-")
	const jusoZip = scratch.path("202608ALLMTCHG00.zip").toString()

	await writeLocalBuffer(Buffer.from((await readLocalTextFile(FIXTURE)).trim(), "base64"), jusoZip)

	const regions = new Set((await Array.fromAsync(readJusoLabelRows(jusoZip))).map((row) => row.region))
	const limited = await Array.fromAsync(readJusoLabelRows(jusoZip, { maxRowsPerRegion: 0 }))

	expect(regions.size).toBeGreaterThan(0)
	expect(limited.map((row) => row.region)).toEqual([...regions])
})
