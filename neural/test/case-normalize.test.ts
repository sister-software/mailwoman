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

import {
	isAllCapsInput,
	isAllLowerInput,
	normalizeInputCase,
	restoreLowerInput,
	titleCaseInput,
} from "../case-normalize.ts"

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
	it("title-cases ASCII runs ≥3 letters, preserves ≤2-letter all-caps runs (#252), preserves length", () => {
		expect(titleCaseInput("PALESTINE")).toBe("Palestine")
		// #252: ≤2-letter all-caps runs are state codes / suffix abbrevs (TX, RD, ST) — title-casing them
		// (Tx, Rd) corrupted the region signal. Preserve them; the model reads both forms.
		expect(titleCaseInput("214 JONES RD")).toBe("214 Jones RD")
		expect(titleCaseInput("ELKHART TX")).toBe("Elkhart TX")
		const caps = "214 JONES RD, ELKHART, TX 75839"
		expect(titleCaseInput(caps).length).toBe(caps.length) // offsets survive
	})
})

describe("isAllLowerInput (#829 — the mirror of isAllCapsInput)", () => {
	it("detects a pure-ASCII all-lowercase address", () => {
		expect(isAllLowerInput("1600 pennsylvania ave nw, washington dc")).toBe(true)
		expect(isAllLowerInput("abc")).toBe(true)
	})

	it("leaves mixed-case alone (one uppercase ⇒ false)", () => {
		expect(isAllLowerInput("109 Seminary Dr, Mill Valley, CA 94941")).toBe(false)
		expect(isAllLowerInput("abC")).toBe(false)
	})

	it("ignores tiny / letterless inputs (3-letter floor)", () => {
		expect(isAllLowerInput("tx")).toBe(false)
		expect(isAllLowerInput("123 456, 90210")).toBe(false)
	})

	it("BAILS on any non-ASCII letter (same length/locale concern as the all-caps detector)", () => {
		expect(isAllLowerInput("café de parís")).toBe(false)
		expect(isAllLowerInput("straße über")).toBe(false)
		expect(isAllLowerInput("москва улица")).toBe(false)
	})
})

describe("restoreLowerInput (#829)", () => {
	it("title-cases ≥3-letter runs and UPPERCASES ≤2-letter runs (dc→DC, lg→LG), preserving length", () => {
		expect(restoreLowerInput("pennsylvania")).toBe("Pennsylvania")
		// ≤2-letter runs are abbreviations the model reads best uppercase (state/directional/suffix, NL suffix).
		expect(restoreLowerInput("washington dc")).toBe("Washington DC")
		expect(restoreLowerInput("1012 lg amsterdam")).toBe("1012 LG Amsterdam")
		const lower = "1600 pennsylvania ave nw, washington dc"
		expect(restoreLowerInput(lower).length).toBe(lower.length) // offsets survive
	})
})

describe("normalizeInputCase — the parser hook", () => {
	it("title-cases all-caps input, preserving the 2-letter state code (#252)", () => {
		expect(normalizeInputCase("PALESTINE TX")).toBe("Palestine TX")
	})

	it("canonicalizes all-lowercase input to the trained mixed-case form (#829)", () => {
		expect(normalizeInputCase("1600 pennsylvania ave nw, washington dc")).toBe(
			"1600 Pennsylvania Ave NW, Washington DC"
		)
		expect(normalizeInputCase("damrak 1, 1012 lg amsterdam")).toBe("Damrak 1, 1012 LG Amsterdam")
	})

	it("all-caps and all-lowercase converge on the SAME canonical form", () => {
		const canon = "1600 Pennsylvania Ave NW, Washington DC"
		expect(normalizeInputCase("1600 PENNSYLVANIA AVE NW, WASHINGTON DC")).toBe(canon)
		expect(normalizeInputCase("1600 pennsylvania ave nw, washington dc")).toBe(canon)
	})

	it("returns mixed-case and non-ASCII input UNCHANGED (no-regression by construction)", () => {
		const mixed = "109 Seminary Dr, Mill Valley, CA 94941"
		expect(normalizeInputCase(mixed)).toBe(mixed)
		const accented = "CAFÉ DE PARÍS"
		expect(normalizeInputCase(accented)).toBe(accented)
		const lowerAccented = "café de parís"
		expect(normalizeInputCase(lowerAccented)).toBe(lowerAccented)
	})
})
