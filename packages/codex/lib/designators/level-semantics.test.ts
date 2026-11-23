// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	isLevelDesignatorToken,
	LEVEL_DESIGNATORS_BY_FAMILY,
	levelToOrdinal,
	lookupLevelDesignator,
} from "#designators/level-semantics"

describe("LEVEL_DESIGNATORS_BY_FAMILY — table integrity", () => {
	it("every row has a non-empty code and name", () => {
		for (const [family, rows] of Object.entries(LEVEL_DESIGNATORS_BY_FAMILY)) {
			for (const row of rows) {
				expect(row.code.length, `${family}.${row.code} code`).toBeGreaterThan(0)
				expect(row.name.length, `${family}.${row.code} name`).toBeGreaterThan(0)
			}
		}
	})

	it("the same token CAN mean different things ACROSS families — that's the whole point", () => {
		// "UG" is Upper Ground (a fractional, above-ground level) in English…
		expect(lookupLevelDesignator("UG", "en-GB")?.kind).toBe("fractionalAboveGround")
		// …but Untergeschoss (a basement level) in German.
		expect(lookupLevelDesignator("UG", "de-DE")?.kind).toBe("basement")
	})
})

describe("levelToOrdinal — headline semantics", () => {
	it("US: the 1st numbered floor IS ground (ordinal 0)", () => {
		expect(levelToOrdinal("FL", 1, "en-US")).toBe(0)
		expect(levelToOrdinal("FLOOR", 2, "en-US")).toBe(1)
	})

	it("Canada follows the US/JP convention regardless of language (English or French)", () => {
		expect(levelToOrdinal("FL", 1, "en-CA")).toBe(0)
		expect(levelToOrdinal("ÉTAGE", 1, "fr-CA")).toBe(0)
	})

	it("France: the 1st étage is ONE STOREY ABOVE ground (ordinal 1)", () => {
		expect(levelToOrdinal("étage", 1, "fr-FR")).toBe(1)
	})

	it("France: RDC (ground) is always ordinal 0, number ignored", () => {
		expect(levelToOrdinal("RDC", null, "fr-FR")).toBe(0)
	})

	it("Germany: OG (Obergeschoss) follows the continental convention (1 → ordinal 1)", () => {
		expect(levelToOrdinal("OG", 1, "de-DE")).toBe(1)
	})

	it("Germany: EG (Erdgeschoss, ground) is always ordinal 0", () => {
		expect(levelToOrdinal("EG", null, "de-DE")).toBe(0)
	})

	it("basement designators negate the number — B1/UG1-style basements are ordinal -1", () => {
		expect(levelToOrdinal("B", 1, "en-US")).toBe(-1)
		expect(levelToOrdinal("UG", 1, "de-DE")).toBe(-1)
		expect(levelToOrdinal("SS", 1, "fr-FR")).toBe(-1)
		expect(levelToOrdinal("SÓTANO", 2, "es-ES")).toBe(-2)
	})

	it("a bare basement designator with no number defaults to the first basement level (-1)", () => {
		expect(levelToOrdinal("BASEMENT", null, "en-US")).toBe(-1)
	})

	it("Spain: PLANTA BAJA (ground) is always ordinal 0", () => {
		expect(levelToOrdinal("PLANTA BAJA", null, "es-ES")).toBe(0)
		expect(levelToOrdinal("bajo", null, "es-ES")).toBe(0)
	})

	it("Spain: PRINCIPAL is a fixed ordinal-1 floor, independent of any number passed", () => {
		expect(levelToOrdinal("PRINCIPAL", null, "es-ES")).toBe(1)
		expect(levelToOrdinal("PRINCIPAL", 7, "es-ES")).toBe(1)
	})

	it("Spain: ENTRESUELO (a genuinely fractional 0.5) floors to ordinal 0, grouped with ground", () => {
		expect(levelToOrdinal("ENTRESUELO", null, "es-ES")).toBe(0)
	})

	it("UK: LOWER GROUND floors to -1; UPPER GROUND floors to 0", () => {
		expect(levelToOrdinal("LG", null, "en-GB")).toBe(-1)
		expect(levelToOrdinal("UG", null, "en-GB")).toBe(0)
	})

	it("Japan: 1F IS ground (ordinal 0); higher F numbers follow the US/JP convention", () => {
		expect(levelToOrdinal("F", 1, "ja-JP")).toBe(0)
		expect(levelToOrdinal("F", 2, "ja-JP")).toBe(1)
		expect(levelToOrdinal("階", 1, "ja-JP")).toBe(0)
	})

	it("Japan: B1F is ordinal -1 (same basement semantics as English B1)", () => {
		expect(levelToOrdinal("B", 1, "ja-JP")).toBe(-1)
	})

	it("Italy: PIANO TERRA (ground) is ordinal 0; SEMINTERRATO floors to -1", () => {
		expect(levelToOrdinal("PIANO TERRA", null, "it-IT")).toBe(0)
		expect(levelToOrdinal("SEMINTERRATO", null, "it-IT")).toBe(0 - 1)
	})

	it("Portugal: RC (ground) is ordinal 0", () => {
		expect(levelToOrdinal("RC", null, "pt-PT")).toBe(0)
	})

	it("Netherlands: BG (begane grond) is ordinal 0", () => {
		expect(levelToOrdinal("BG", null, "nl-NL")).toBe(0)
	})

	it("Nordics: the shared continental convention applies to Swedish, Norwegian, and Danish", () => {
		expect(levelToOrdinal("BV", null, "sv-SE")).toBe(0)
		expect(levelToOrdinal("VÅNING", 1, "sv-SE")).toBe(1)
		expect(levelToOrdinal("GATEPLAN", null, "nb-NO")).toBe(0)
		expect(levelToOrdinal("ETASJE", 1, "nb-NO")).toBe(1)
		expect(levelToOrdinal("STUEN", null, "da-DK")).toBe(0)
		expect(levelToOrdinal("ETAGE", 1, "da-DK")).toBe(1)
	})

	it("special (building-relative) designators have no locale-independent ordinal", () => {
		expect(levelToOrdinal("PH", null, "en-US")).toBeNull()
		expect(levelToOrdinal("ROOF", null, "en-GB")).toBeNull()
		expect(levelToOrdinal("DG", null, "de-DE")).toBeNull()
		expect(levelToOrdinal("ÁTICO", null, "es-ES")).toBeNull()
		expect(levelToOrdinal("ATTICO", null, "it-IT")).toBeNull()
	})

	it("a bare 'en' locale (no country) cannot resolve a numbered ordinal — US and UK disagree", () => {
		expect(levelToOrdinal("FL", 1, "en")).toBeNull()
	})

	it("a bare 'en' locale CAN still resolve ground/basement/special kinds — they don't need the convention", () => {
		expect(levelToOrdinal("GROUND", null, "en")).toBe(0)
		expect(levelToOrdinal("B", 1, "en")).toBe(-1)
	})

	it("a numbered designator with no number returns null rather than guessing", () => {
		expect(levelToOrdinal("FL", null, "en-US")).toBeNull()
	})

	it("returns null for an unrecognized designator", () => {
		expect(levelToOrdinal("XYZZY", 1, "en-US")).toBeNull()
	})

	it("returns null for a locale this module has no lexicon for", () => {
		expect(levelToOrdinal("FL", 1, "xx-XX")).toBeNull()
		expect(levelToOrdinal("FL", 1, "zh-CN")).toBeNull()
	})
})

describe("lookupLevelDesignator / isLevelDesignatorToken", () => {
	it("resolves canonical codes, abbreviations, and variants case-insensitively", () => {
		expect(lookupLevelDesignator("fl", "en-US")?.code).toBe("FLOOR")
		expect(lookupLevelDesignator("Level", "en-US")?.code).toBe("FLOOR")
		expect(lookupLevelDesignator("étage", "fr-FR")?.code).toBe("ÉTAGE")
		expect(lookupLevelDesignator("etage", "fr-FR")?.code).toBe("ÉTAGE")
	})

	it("returns null for an unrecognized token or an unknown locale family", () => {
		expect(lookupLevelDesignator("nonsense", "en-US")).toBeNull()
		expect(lookupLevelDesignator("FL", "xx-XX")).toBeNull()
	})

	it("isLevelDesignatorToken mirrors lookupLevelDesignator's recognition", () => {
		expect(isLevelDesignatorToken("FL", "en-US")).toBe(true)
		expect(isLevelDesignatorToken("étage", "fr-FR")).toBe(true)
		expect(isLevelDesignatorToken("nonsense", "en-US")).toBe(false)
		expect(isLevelDesignatorToken(42, "en-US")).toBe(false)
	})
})
