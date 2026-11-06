/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	decode2,
	decode3,
	decodeNumeric,
	encode2,
	encode3,
	encodeNumeric,
	KEY_SPACE_2,
	KEY_SPACE_3,
	NO_KEY,
} from "#key"

describe("key encodings", () => {
	it("round-trips every three-letter key", () => {
		for (let key = 0; key < KEY_SPACE_3; key++) {
			expect(encode3(decode3(key))).toBe(key)
		}
	})

	it("round-trips every two-letter key", () => {
		for (let key = 0; key < KEY_SPACE_2; key++) {
			expect(encode2(decode2(key))).toBe(key)
		}
	})

	it("keeps a numeric code's leading zero", () => {
		expect(encodeNumeric("036")).toBe(36)
		expect(decodeNumeric(36)).toBe("036")
	})

	it.each(["aus", "AU", "AUS ", " AUS", "A1S", "ÄUS", "AUSS", ""])("refuses %j as a three-letter key", (code) => {
		expect(encode3(code)).toBe(NO_KEY)
	})

	it.each(["36", "03a", "1000"])("refuses %j as a numeric key", (code) => {
		expect(encodeNumeric(code)).toBe(NO_KEY)
	})

	it("agrees with the Rust encoder on the spec's formula", () => {
		// A = 0, U = 20, S = 18.
		expect(encode3("AUS")).toBe(20 * 26 + 18)
		expect(encode2("US")).toBe(20 * 26 + 18)
	})
})
