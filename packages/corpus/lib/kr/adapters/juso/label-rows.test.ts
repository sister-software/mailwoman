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

import { parenthetical, readJusoLabelRows } from "#kr/adapters/juso/label-rows"
import { renderKRRow } from "#kr/corpus/rows"

const FIXTURE = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "kr", "juso-fixture.zip.b64")

test("joins the archive's four files into one row per address and recodes the member names", async () => {
	await using scratch = await temporaryDirectory("mailwoman-kr-juso-")
	const jusoZip = scratch.path("202608ALLMTCHG00.zip").toString()

	await writeLocalBuffer(Buffer.from((await readLocalTextFile(FIXTURE)).trim(), "base64"), jusoZip)

	const rows = await Array.fromAsync(readJusoLabelRows(jusoZip))
	const jongno = rows.find((row) => row.road === "자하문로" && row.number === "94")

	// The fixture holds four 시도.
	// The 읍/면 rendering a Gangwon row exercised in Python is in `kr/corpus/rows.test.ts`.
	expect([...new Set(rows.map((row) => row.region))].toSorted()).toEqual([
		"경기도",
		"부산광역시",
		"서울특별시",
		"제주특별자치도",
	])

	expect(jongno).toEqual({
		region: "서울특별시",
		sigungu: "종로구",
		eupmyeon: "",
		dong: "청운동",
		ri: "",
		road: "자하문로",
		number: "94",
		postcode: "03047",
		building: "청운빌딩",
		lot: "52-1",
		underground: false,
	})

	expect(parenthetical(jongno!)).toBe("청운동")
	expect(renderKRRow(jongno!, { register: "official" }).raw).toBe("서울특별시 종로구 자하문로 94 (청운동)")

	// The smoke-build cap is per region: one row from each 시도.
	expect(await Array.fromAsync(readJusoLabelRows(jusoZip, { maxRowsPerRegion: 1 }))).toHaveLength(
		new Set(rows.map((row) => row.region)).size
	)
})

test("a limit of 0 rows per region emits one row per region, as Python's loop did", async () => {
	await using scratch = await temporaryDirectory("mailwoman-kr-juso-")
	const jusoZip = scratch.path("202608ALLMTCHG00.zip").toString()

	await writeLocalBuffer(Buffer.from((await readLocalTextFile(FIXTURE)).trim(), "base64"), jusoZip)

	const regions = new Set((await Array.fromAsync(readJusoLabelRows(jusoZip))).map((row) => row.region))
	const limited = await Array.fromAsync(readJusoLabelRows(jusoZip, { maxRowsPerRegion: 0 }))

	expect(regions.size).toBeGreaterThan(0)
	expect(limited.map((row) => row.region)).toEqual([...regions])
})
