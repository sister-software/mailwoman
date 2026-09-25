/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isNLPostcodeKey, NL_PC6_KEY_PATTERN } from "@mailwoman/codex/nl"
import { expect, test } from "vitest"

test("isNLPostcodeKey: accepts the compact, upper-case PC6 key", () => {
	expect(isNLPostcodeKey("1012LG")).toBe(true)
	expect(isNLPostcodeKey("0000AA")).toBe(true)
	expect(isNLPostcodeKey("9999ZZ")).toBe(true)
})

test("isNLPostcodeKey: refuses the spaced and lower-case surfaces a reader would expect it to take", () => {
	// Both are real spellings of a real postcode and both select zero gazetteer rows.
	// The caller normalizes before the check rather than the check accepting them.
	expect(isNLPostcodeKey("1012 LG")).toBe(false)
	expect(isNLPostcodeKey("1012lg")).toBe(false)
	expect(isNLPostcodeKey(" 1012LG")).toBe(false)
})

test("isNLPostcodeKey: refuses another country's postcode and a non-string", () => {
	expect(isNLPostcodeKey("1012")).toBe(false)
	expect(isNLPostcodeKey("10123LG")).toBe(false)
	expect(isNLPostcodeKey("LG1012")).toBe(false)
	expect(isNLPostcodeKey("SW1A1AA")).toBe(false)
	expect(isNLPostcodeKey("")).toBe(false)
	expect(isNLPostcodeKey(1012)).toBe(false)
	expect(isNLPostcodeKey(null)).toBe(false)
	expect(isNLPostcodeKey(undefined)).toBe(false)
})

test("NL_PC6_KEY_PATTERN carries no global flag, so repeated tests do not advance a lastIndex", () => {
	expect(NL_PC6_KEY_PATTERN.test("1012LG")).toBe(true)
	expect(NL_PC6_KEY_PATTERN.test("1012LG")).toBe(true)
})
