/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #690 input case-normalization — detection + transform. The essential guarantees: mixed-case and
 *   non-ASCII input are NEVER touched (byte-stable, the no-regression-by-construction), and the
 *   transform is length-preserving (token offsets survive).
 */

import { describe, expect, it } from "vitest"
import { isAllCapsInput, normalizeInputCase, titleCaseInput } from "../case-normalize.js"

describe("isAllCapsInput", () => {
	it("detects a pure-ASCII all-caps address", () => {
		expect(isAllCapsInput("214 JONES RD, ELKHART, TX 75839")).toBe(true)
		expect(isAllCapsInput("ABC")).toBe(true)
	})

	it("leaves mixed-case alone (one lowercase ⇒ false)", () => {
		expect(isAllCapsInput("109 Seminary Dr, Mill Valley, CA 94941")).toBe(false)
		expect(isAllCapsInput("ABc")).toBe(false)
	})

	it("ignores tiny / letterless inputs (3-letter floor)", () => {
		expect(isAllCapsInput("TX")).toBe(false)
		expect(isAllCapsInput("123 456, 90210")).toBe(false)
	})

	it("BAILS on any non-ASCII letter — accented + non-Latin (DeepSeek's length/locale concern)", () => {
		expect(isAllCapsInput("CAFÉ DE PARÍS")).toBe(false) // accented all-caps Latin
		expect(isAllCapsInput("STRASSE GROSSER ZOLLERN ÜBER")).toBe(false) // German Ü
		expect(isAllCapsInput("МОСКВА УЛИЦА")).toBe(false) // Cyrillic
		expect(isAllCapsInput("東京都")).toBe(false) // CJK
	})
})

describe("titleCaseInput", () => {
	it("title-cases each ASCII run and preserves length", () => {
		expect(titleCaseInput("PALESTINE")).toBe("Palestine")
		expect(titleCaseInput("214 JONES RD")).toBe("214 Jones Rd")
		const caps = "214 JONES RD, ELKHART, TX 75839"
		expect(titleCaseInput(caps).length).toBe(caps.length) // offsets survive
	})
})

describe("normalizeInputCase — the parser hook", () => {
	it("title-cases all-caps input", () => {
		expect(normalizeInputCase("PALESTINE TX")).toBe("Palestine Tx")
	})

	it("returns mixed-case and non-ASCII input UNCHANGED (no-regression by construction)", () => {
		const mixed = "109 Seminary Dr, Mill Valley, CA 94941"
		expect(normalizeInputCase(mixed)).toBe(mixed)
		const accented = "CAFÉ DE PARÍS"
		expect(normalizeInputCase(accented)).toBe(accented)
	})
})
