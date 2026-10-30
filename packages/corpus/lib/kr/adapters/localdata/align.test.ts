/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import type { JusoLabelRow } from "#kr/adapters/juso/label-rows"
import { alignRoadAddress } from "#kr/adapters/localdata/align"
import { emptyKeyIndex, indexLabelRow } from "#kr/adapters/localdata/key-index"

const ROW: JusoLabelRow = {
	region: "서울특별시",
	sigungu: "중구",
	eupmyeon: "",
	dong: "태평로1가",
	ri: "",
	road: "세종대로",
	number: "110",
	postcode: "04524",
	building: "",
	lot: "31",
	underground: false,
}

test("a building number in fullwidth digits aligns, as Python's \\d matched it", () => {
	const index = emptyKeyIndex()

	indexLabelRow(index, ROW)

	const aligned = alignRoadAddress("서울특별시 중구 세종대로 １１０", index)

	expect(aligned).not.toBeNull()
	expect(aligned!.spanTags).toContain("house_number")
})

test("a building number in a digit set Unicode 15.0 did not assign does not align", () => {
	const index = emptyKeyIndex()

	indexLabelRow(index, ROW)

	// Garay digits, assigned in Unicode 16.0: Node's \p{Nd} matches them and CPython 3.12's \d does not.
	expect(alignRoadAddress("서울특별시 중구 세종대로 \u{10D41}\u{10D41}\u{10D40}", index)).toBeNull()
})
