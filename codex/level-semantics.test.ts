/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	DA_LEVEL_DESIGNATORS,
	DE_LEVEL_DESIGNATORS,
	EN_LEVEL_DESIGNATORS,
	ES_LEVEL_DESIGNATORS,
	FR_LEVEL_DESIGNATORS,
	IT_LEVEL_DESIGNATORS,
	isLevelDesignatorToken,
	JA_LEVEL_DESIGNATORS,
	LEVEL_DESIGNATORS_BY_FAMILY,
	levelToOrdinal,
	lookupLevelDesignator,
	NL_LEVEL_DESIGNATORS,
	NO_LEVEL_DESIGNATORS,
	PT_LEVEL_DESIGNATORS,
	SV_LEVEL_DESIGNATORS,
} from "./level-semantics.ts"

describe("LEVEL_DESIGNATORS_BY_FAMILY — table integrity", () => {
	it("carries all eleven language families", () => {
		expect(Object.keys(LEVEL_DESIGNATORS_BY_FAMILY).sort()).toEqual(
			["en", "fr", "de", "es", "it", "pt", "nl", "ja", "sv", "no", "da"].sort()
		)
	})

	it("every row has a non-empty code, name, and at least one variant", () => {
		for (const [family, rows] of Object.entries(LEVEL_DESIGNATORS_BY_FAMILY)) {
			for (const row of rows) {
				expect(row.code.length, `${family}.${row.code} code`).toBeGreaterThan(0)
				expect(row.name.length, `${family}.${row.code} name`).toBeGreaterThan(0)
				expect(row.variants.length, `${family}.${row.code} variants`).toBeGreaterThan(0)

				for (const variant of row.variants) {
					expect(variant.trim().length, `${family}.${row.code} variant "${variant}"`).toBeGreaterThan(0)
				}
			}
		}
	})

	it("has no duplicate variant WITHIN any single locale family (case-insensitive)", () => {
		for (const [family, rows] of Object.entries(LEVEL_DESIGNATORS_BY_FAMILY)) {
			const seen = new Map<string, string>()

			for (const row of rows) {
				for (const variant of row.variants) {
					const key = variant.toLowerCase()
					const existing = seen.get(key)

					expect(
						existing,
						`family "${family}": variant "${variant}" claimed by both "${existing}" and "${row.code}"`
					).toBeUndefined()
					seen.set(key, row.code)
				}
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
		expect(levelToOrdinal("RDC", undefined, "fr-FR")).toBe(0)
	})

	it("Germany: OG (Obergeschoss) follows the continental convention (1 → ordinal 1)", () => {
		expect(levelToOrdinal("OG", 1, "de-DE")).toBe(1)
	})

	it("Germany: EG (Erdgeschoss, ground) is always ordinal 0", () => {
		expect(levelToOrdinal("EG", undefined, "de-DE")).toBe(0)
	})

	it("basement designators negate the number — B1/UG1-style basements are ordinal -1", () => {
		expect(levelToOrdinal("B", 1, "en-US")).toBe(-1)
		expect(levelToOrdinal("UG", 1, "de-DE")).toBe(-1)
		expect(levelToOrdinal("SS", 1, "fr-FR")).toBe(-1)
		expect(levelToOrdinal("SÓTANO", 2, "es-ES")).toBe(-2)
	})

	it("a bare basement designator with no number defaults to the first basement level (-1)", () => {
		expect(levelToOrdinal("BASEMENT", undefined, "en-US")).toBe(-1)
	})

	it("Spain: PLANTA BAJA (ground) is always ordinal 0", () => {
		expect(levelToOrdinal("PLANTA BAJA", undefined, "es-ES")).toBe(0)
		expect(levelToOrdinal("bajo", undefined, "es-ES")).toBe(0)
	})

	it("Spain: PRINCIPAL is a fixed ordinal-1 floor, independent of any number passed", () => {
		expect(levelToOrdinal("PRINCIPAL", undefined, "es-ES")).toBe(1)
		expect(levelToOrdinal("PRINCIPAL", 7, "es-ES")).toBe(1)
	})

	it("Spain: ENTRESUELO (a genuinely fractional 0.5) floors to ordinal 0, grouped with ground", () => {
		expect(levelToOrdinal("ENTRESUELO", undefined, "es-ES")).toBe(0)
	})

	it("UK: LOWER GROUND floors to -1; UPPER GROUND floors to 0", () => {
		expect(levelToOrdinal("LG", undefined, "en-GB")).toBe(-1)
		expect(levelToOrdinal("UG", undefined, "en-GB")).toBe(0)
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
		expect(levelToOrdinal("PIANO TERRA", undefined, "it-IT")).toBe(0)
		expect(levelToOrdinal("SEMINTERRATO", undefined, "it-IT")).toBe(0 - 1)
	})

	it("Portugal: RC (ground) is ordinal 0", () => {
		expect(levelToOrdinal("RC", undefined, "pt-PT")).toBe(0)
	})

	it("Netherlands: BG (begane grond) is ordinal 0", () => {
		expect(levelToOrdinal("BG", undefined, "nl-NL")).toBe(0)
	})

	it("Nordics: the shared continental convention applies to Swedish, Norwegian, and Danish", () => {
		expect(levelToOrdinal("BV", undefined, "sv-SE")).toBe(0)
		expect(levelToOrdinal("VÅNING", 1, "sv-SE")).toBe(1)
		expect(levelToOrdinal("GATEPLAN", undefined, "nb-NO")).toBe(0)
		expect(levelToOrdinal("ETASJE", 1, "nb-NO")).toBe(1)
		expect(levelToOrdinal("STUEN", undefined, "da-DK")).toBe(0)
		expect(levelToOrdinal("ETAGE", 1, "da-DK")).toBe(1)
	})

	it("special (building-relative) designators have no locale-independent ordinal", () => {
		expect(levelToOrdinal("PH", undefined, "en-US")).toBeUndefined()
		expect(levelToOrdinal("ROOF", undefined, "en-GB")).toBeUndefined()
		expect(levelToOrdinal("DG", undefined, "de-DE")).toBeUndefined()
		expect(levelToOrdinal("ÁTICO", undefined, "es-ES")).toBeUndefined()
		expect(levelToOrdinal("ATTICO", undefined, "it-IT")).toBeUndefined()
	})

	it("a bare 'en' locale (no country) cannot resolve a numbered ordinal — US and UK disagree", () => {
		expect(levelToOrdinal("FL", 1, "en")).toBeUndefined()
	})

	it("a bare 'en' locale CAN still resolve ground/basement/special kinds — they don't need the convention", () => {
		expect(levelToOrdinal("GROUND", undefined, "en")).toBe(0)
		expect(levelToOrdinal("B", 1, "en")).toBe(-1)
	})

	it("a numbered designator with no number returns undefined rather than guessing", () => {
		expect(levelToOrdinal("FL", undefined, "en-US")).toBeUndefined()
	})

	it("returns undefined for an unrecognized designator", () => {
		expect(levelToOrdinal("XYZZY", 1, "en-US")).toBeUndefined()
	})

	it("returns undefined for a locale this module has no lexicon for", () => {
		expect(levelToOrdinal("FL", 1, "xx-XX")).toBeUndefined()
		expect(levelToOrdinal("FL", 1, "zh-CN")).toBeUndefined()
	})
})

describe("lookupLevelDesignator / isLevelDesignatorToken", () => {
	it("resolves canonical codes, abbreviations, and variants case-insensitively", () => {
		expect(lookupLevelDesignator("fl", "en-US")?.code).toBe("FLOOR")
		expect(lookupLevelDesignator("Level", "en-US")?.code).toBe("FLOOR")
		expect(lookupLevelDesignator("étage", "fr-FR")?.code).toBe("ÉTAGE")
		expect(lookupLevelDesignator("etage", "fr-FR")?.code).toBe("ÉTAGE")
	})

	it("returns undefined for an unrecognized token or an unknown locale family", () => {
		expect(lookupLevelDesignator("nonsense", "en-US")).toBeUndefined()
		expect(lookupLevelDesignator("FL", "xx-XX")).toBeUndefined()
	})

	it("isLevelDesignatorToken mirrors lookupLevelDesignator's recognition", () => {
		expect(isLevelDesignatorToken("FL", "en-US")).toBe(true)
		expect(isLevelDesignatorToken("étage", "fr-FR")).toBe(true)
		expect(isLevelDesignatorToken("nonsense", "en-US")).toBe(false)
		expect(isLevelDesignatorToken(42, "en-US")).toBe(false)
	})
})

describe("per-family designator counts — sanity check against the module docstring's designator list", () => {
	it("English carries FLOOR, BASEMENT, PENTHOUSE, GROUND, LOWER/UPPER GROUND, MEZZANINE, and ROOF", () => {
		expect(EN_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(
			["FLOOR", "BASEMENT", "PENTHOUSE", "GROUND", "LOWER GROUND", "UPPER GROUND", "MEZZANINE", "ROOF"].sort()
		)
	})

	it("French carries ÉTAGE, RDC, SOUS-SOL, and ENTRESOL", () => {
		expect(FR_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(["ÉTAGE", "RDC", "SOUS-SOL", "ENTRESOL"].sort())
	})

	it("German carries OBERGESCHOSS, ERDGESCHOSS, UNTERGESCHOSS, DACHGESCHOSS, and ZWISCHENGESCHOSS", () => {
		expect(DE_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(
			["OBERGESCHOSS", "ERDGESCHOSS", "UNTERGESCHOSS", "DACHGESCHOSS", "ZWISCHENGESCHOSS"].sort()
		)
	})

	it("Spanish carries PLANTA, PLANTA BAJA, ENTRESUELO, PRINCIPAL, SÓTANO, and ÁTICO", () => {
		expect(ES_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(
			["PLANTA", "PLANTA BAJA", "ENTRESUELO", "PRINCIPAL", "SÓTANO", "ÁTICO"].sort()
		)
	})

	it("Italian carries PIANO, PIANO TERRA, SEMINTERRATO, and ATTICO", () => {
		expect(IT_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(
			["PIANO", "PIANO TERRA", "SEMINTERRATO", "ATTICO"].sort()
		)
	})

	it("Portuguese carries ANDAR, RÉS-DO-CHÃO, and CAVE", () => {
		expect(PT_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(["ANDAR", "RÉS-DO-CHÃO", "CAVE"].sort())
	})

	it("Dutch carries VERDIEPING, BEGANE GROND, and KELDER", () => {
		expect(NL_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(["VERDIEPING", "BEGANE GROND", "KELDER"].sort())
	})

	it("Japanese carries F, B, and RF", () => {
		expect(JA_LEVEL_DESIGNATORS.map((r) => r.code).sort()).toEqual(["F", "B", "RF"].sort())
	})

	it("Swedish, Norwegian, and Danish each carry a numbered/ground/basement triple", () => {
		expect(SV_LEVEL_DESIGNATORS).toHaveLength(3)
		expect(NO_LEVEL_DESIGNATORS).toHaveLength(3)
		expect(DA_LEVEL_DESIGNATORS).toHaveLength(3)
	})
})
