/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isJapanesePrefectureCode, JP_PREFECTURES, lookupJapanesePrefecture } from "./prefecture.js"

describe("JP_PREFECTURES", () => {
	it("covers all 47 prefectures", () => {
		expect(Object.keys(JP_PREFECTURES)).toHaveLength(47)
		expect(JP_PREFECTURES["13"].kanji).toBe("東京都")
		expect(JP_PREFECTURES["13"].romaji).toBe("Tokyo")
	})

	it("has the legal to/dō/fu/ken split (1 to, 1 do, 2 fu, 43 ken)", () => {
		const counts = { to: 0, do: 0, fu: 0, ken: 0 }

		for (const info of Object.values(JP_PREFECTURES)) counts[info.type]++
		expect(counts).toEqual({ to: 1, do: 1, fu: 2, ken: 43 })
	})

	it("pins the four special-type prefectures by name", () => {
		expect(JP_PREFECTURES["13"].type).toBe("to") // Tokyo
		expect(JP_PREFECTURES["01"].type).toBe("do") // Hokkaido
		expect(JP_PREFECTURES["26"].type).toBe("fu") // Kyoto
		expect(JP_PREFECTURES["27"].type).toBe("fu") // Osaka
	})
})

describe("isJapanesePrefectureCode", () => {
	it("accepts the two-digit ISO 3166-2:JP codes", () => {
		expect(isJapanesePrefectureCode("13")).toBe(true)
		expect(isJapanesePrefectureCode("01")).toBe(true)
		expect(isJapanesePrefectureCode("47")).toBe(true)
		expect(isJapanesePrefectureCode("48")).toBe(false) // out of range
		expect(isJapanesePrefectureCode("1")).toBe(false) // not zero-padded
	})
})

describe("lookupJapanesePrefecture", () => {
	it("resolves a code directly", () => {
		expect(lookupJapanesePrefecture("13")).toBe("13")
		expect(lookupJapanesePrefecture("27")).toBe("27")
	})

	it("resolves romaji, case-insensitive and macron-optional", () => {
		expect(lookupJapanesePrefecture("Tokyo")).toBe("13")
		expect(lookupJapanesePrefecture("tokyo")).toBe("13")
		expect(lookupJapanesePrefecture("Tōkyō")).toBe("13") // macrons folded
		expect(lookupJapanesePrefecture("Osaka")).toBe("27")
	})

	it("resolves romaji with the appended -to / -fu / -ken type-suffix", () => {
		expect(lookupJapanesePrefecture("Tokyo-to")).toBe("13")
		expect(lookupJapanesePrefecture("Osaka-fu")).toBe("27")
		expect(lookupJapanesePrefecture("Aomori-ken")).toBe("02")
	})

	it("does NOT clip a bare romaji name that merely ends in a suffix syllable", () => {
		// The guard: only a separated suffix is stripped, so Kyoto/Gifu/Hokkaido/Kumamoto survive.
		expect(lookupJapanesePrefecture("Kyoto")).toBe("26")
		expect(lookupJapanesePrefecture("Gifu")).toBe("21")
		expect(lookupJapanesePrefecture("Hokkaido")).toBe("01")
		expect(lookupJapanesePrefecture("Kumamoto")).toBe("43")
	})

	it("resolves kanji, with or without the 都/道/府/県 suffix", () => {
		expect(lookupJapanesePrefecture("東京都")).toBe("13")
		expect(lookupJapanesePrefecture("東京")).toBe("13")
		expect(lookupJapanesePrefecture("大阪府")).toBe("27")
		expect(lookupJapanesePrefecture("大阪")).toBe("27")
		expect(lookupJapanesePrefecture("北海道")).toBe("01") // indivisible, indexed whole
	})

	it("returns null for an unknown surface form", () => {
		expect(lookupJapanesePrefecture("Bavaria")).toBeNull()
		expect(lookupJapanesePrefecture("48")).toBeNull()
		expect(lookupJapanesePrefecture("北海")).toBeNull() // Hokkaido is never clipped to 北海
		expect(lookupJapanesePrefecture("")).toBeNull()
		expect(lookupJapanesePrefecture(null)).toBeNull()
	})
})
