/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { isJapaneseAdminSuffix, JP_ADMIN_SUFFIXES, JP_BLOCK_MARKERS, stripAdminSuffix } from "./address-unit.js"

describe("JP_ADMIN_SUFFIXES / JP_BLOCK_MARKERS", () => {
	it("carries the prefecture-level and city-level admin markers", () => {
		expect(JP_ADMIN_SUFFIXES).toContain("都") // metropolis (Tokyo)
		expect(JP_ADMIN_SUFFIXES).toContain("県") // prefecture
		expect(JP_ADMIN_SUFFIXES).toContain("市") // city
		expect(JP_ADMIN_SUFFIXES).toContain("区") // ward
	})

	it("carries the numbered-tail block markers (the no-street house-number stand-in)", () => {
		expect(JP_BLOCK_MARKERS).toContain("丁目") // chōme
		expect(JP_BLOCK_MARKERS).toContain("番地") // banchi
		expect(JP_BLOCK_MARKERS).toContain("号") // gō
	})
})

describe("isJapaneseAdminSuffix", () => {
	it("accepts a single admin-suffix kanji", () => {
		expect(isJapaneseAdminSuffix("都")).toBe(true)
		expect(isJapaneseAdminSuffix("市")).toBe(true)
		expect(isJapaneseAdminSuffix("区")).toBe(true)
	})

	it("rejects non-suffixes and multi-character input", () => {
		expect(isJapaneseAdminSuffix("X")).toBe(false)
		expect(isJapaneseAdminSuffix("東京都")).toBe(false) // a name, not a lone suffix
		expect(isJapaneseAdminSuffix(123)).toBe(false)
	})
})

describe("stripAdminSuffix", () => {
	it("removes a trailing admin-suffix kanji from a place name", () => {
		expect(stripAdminSuffix("東京都")).toBe("東京")
		expect(stripAdminSuffix("大阪市")).toBe("大阪")
		expect(stripAdminSuffix("千代田区")).toBe("千代田")
	})

	it("leaves Hokkaido whole — its 道 is indivisible", () => {
		expect(stripAdminSuffix("北海道")).toBe("北海道")
	})

	it("leaves a name with no admin suffix untouched", () => {
		expect(stripAdminSuffix("渋谷")).toBe("渋谷")
		expect(stripAdminSuffix("")).toBe("")
	})
})
