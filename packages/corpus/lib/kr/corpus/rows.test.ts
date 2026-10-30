/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Each register's rendered form of one 주소DB row, ported from the deleted `test_kr_corpus.py`.
 */

import { SeededRandom } from "@mailwoman/core/random"
import { beforeAll, describe, expect, it } from "vitest"

import { CJK_LABEL_SET_NAME, readLabelSetTags, verifyCJKRecord, type CJKRecord } from "#cjk/builder"
import type { JusoLabelRow } from "#kr/adapters/juso/label-rows"
import {
	availableKRRegisters,
	chooseShortRegion,
	KR_REGISTER_WEIGHTS,
	krIneligibility,
	renderKRRow,
} from "#kr/corpus/rows"

/**
 * The Jongno-gu row of the census: a 동 area, so the parenthetical is the 법정동.
 */
function labelRow(overrides: Partial<JusoLabelRow> = {}): JusoLabelRow {
	return {
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
		...overrides,
	}
}

function spans(record: CJKRecord): Array<[string, string]> {
	const characters = Array.from(record.raw)

	return record.span_tags.map((tag, i) => [
		tag,
		characters.slice(record.span_starts[i]!, record.span_ends[i]!).join(""),
	])
}

let tags: Set<string>

beforeAll(async () => {
	tags = await readLabelSetTags(CJK_LABEL_SET_NAME)
})

function render(row: JusoLabelRow, register: string, extra: { country?: boolean; shortRegion?: string } = {}) {
	const record = renderKRRow(row, { register, ...extra })

	verifyCJKRecord(record, tags)

	return record
}

describe("renderKRRow", () => {
	it("writes the official register in the source form, with the 동 in parentheses", () => {
		const record = render(labelRow(), "official")

		expect(record.raw).toBe("서울특별시 종로구 자하문로 94 (청운동)")

		expect(spans(record)).toEqual([
			["region", "서울특별시"],
			["subregion", "종로구"],
			["street", "자하문로"],
			["house_number", "94"],
			["dependent_locality", "청운동"],
		])
	})

	it("adds the building name inside the parenthetical in the building register", () => {
		const record = render(labelRow(), "building")

		expect(record.raw).toBe("서울특별시 종로구 자하문로 94 (청운동, 청운빌딩)")

		expect(spans(record).slice(-2)).toEqual([
			["dependent_locality", "청운동"],
			["venue", "청운빌딩"],
		])
	})

	it.each([
		["no_dong", "서울특별시 종로구 자하문로 94"],
		["postcode_first", "03047 서울특별시 종로구 자하문로 94"],
		["unspaced", "서울특별시종로구자하문로94"],
	])("writes the %s register as %s, with no dependent_locality", (register, expected) => {
		const record = render(labelRow(), register)

		expect(record.raw).toBe(expected)
		expect(record.span_tags).not.toContain("dependent_locality")
	})

	it("writes the jibun register as the lot form, with the 동 as dependent_locality", () => {
		const record = render(labelRow(), "jibun")

		expect(record.raw).toBe("서울특별시 종로구 청운동 52-1 청운빌딩")

		expect(spans(record)).toEqual([
			["region", "서울특별시"],
			["subregion", "종로구"],
			["dependent_locality", "청운동"],
			["house_number", "52-1"],
			["venue", "청운빌딩"],
		])
	})

	it("writes an 읍/면 row's 면 before the road and its 리 in parentheses, two dependent_locality spans", () => {
		const row = labelRow({
			region: "강원특별자치도",
			sigungu: "원주시",
			eupmyeon: "신림면",
			dong: "신림면",
			ri: "신림리",
			road: "신림황둔로",
			number: "11",
			lot: "668-13",
			building: "",
		})

		const official = render(row, "official")
		const jibun = render(row, "jibun")

		const dependent = (record: CJKRecord) =>
			spans(record)
				.filter(([tag]) => tag === "dependent_locality")
				.map(([, surface]) => surface)

		expect(official.raw).toBe("강원특별자치도 원주시 신림면 신림황둔로 11 (신림리)")
		expect(dependent(official)).toEqual(["신림면", "신림리"])
		expect(jibun.raw).toBe("강원특별자치도 원주시 신림면 신림리 668-13")
		expect(dependent(jibun)).toEqual(["신림면", "신림리"])
	})

	it("keeps 지하 outside the house_number span of an underground number", () => {
		const record = render(labelRow({ underground: true }), "no_dong")

		expect(record.raw).toBe("서울특별시 종로구 자하문로 지하 94")
		expect(spans(record)).toContainEqual(["house_number", "94"])
		expect(spans(record).every(([, surface]) => !surface.includes("지하"))).toBe(true)
	})

	it("replaces only the region span in the short_region register, and refuses one with no short form", () => {
		const record = render(labelRow(), "short_region", { shortRegion: "서울시" })

		expect(record.raw).toBe("서울시 종로구 자하문로 94")
		expect(spans(record)[0]).toEqual(["region", "서울시"])
		expect(() => renderKRRow(labelRow(), { register: "short_region" })).toThrow(/short region/u)
	})

	it("writes a compound 시군구 as two subregion spans with the space outside both", () => {
		const row = labelRow({
			region: "경기도",
			sigungu: "수원시 장안구",
			dong: "파장동",
			road: "영동고속도로",
			number: "31",
		})

		const record = render(row, "no_dong")

		expect(record.raw).toBe("경기도 수원시 장안구 영동고속도로 31")

		expect(spans(record).slice(1, 3)).toEqual([
			["subregion", "수원시"],
			["subregion", "장안구"],
		])

		expect(render(row, "unspaced").raw).toBe("경기도수원시장안구영동고속도로31")
	})

	it("renders Sejong, which has no 시군구, with no subregion span", () => {
		const row = labelRow({
			region: "세종특별자치시",
			sigungu: "",
			dong: "반곡동",
			road: "한누리대로",
			number: "1843-10",
		})

		const record = render(row, "official")

		expect(record.raw).toBe("세종특별자치시 한누리대로 1843-10 (반곡동)")
		expect(record.span_tags).not.toContain("subregion")
		expect(krIneligibility(row, 64)).toBeNull()
	})

	it("leads with the country token as a span", () => {
		const record = render(labelRow(), "no_dong", { country: true })

		expect(record.raw.startsWith("대한민국 ")).toBe(true)
		expect(spans(record)[0]).toEqual(["country", "대한민국"])
	})
})

describe("availableKRRegisters", () => {
	it("offers each register the row can fill", () => {
		expect(availableKRRegisters(labelRow())).toEqual([...KR_REGISTER_WEIGHTS.keys()])

		const withoutDong = availableKRRegisters(labelRow({ dong: "", lot: "" }))

		expect(withoutDong).not.toContain("official")
		expect(withoutDong).not.toContain("jibun")
		expect(availableKRRegisters(labelRow({ building: "" }))).not.toContain("building")
		expect(availableKRRegisters(labelRow({ region: "가상도" }))).not.toContain("short_region")
	})

	it("has a short form for each of the four regions Python's table named", () => {
		for (const region of ["서울특별시", "경기도", "제주특별자치도", "세종특별자치시"]) {
			expect(chooseShortRegion(new SeededRandom(1), region), region).not.toBeNull()
		}
	})
})

describe("krIneligibility", () => {
	it.each([
		[{ number: "" }, "missing_field"],
		[{ road: "가 나" }, "whitespace_shape"],
		[{ sigungu: "가 나 다" }, "whitespace_shape"],
		[{ road: "로".repeat(65) }, "field_too_long"],
		[{}, null],
	] as Array<[Partial<JusoLabelRow>, string | null]>)("answers %j with %s", (overrides, reason) => {
		expect(krIneligibility(labelRow(overrides), 64)).toBe(reason)
	})
})
