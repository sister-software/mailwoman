/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The family registry's own invariants: one family per locale, one family per routing script, and a vocabulary
 *   artifact for every encoder.
 *
 *   These are the two properties `weights-family`'s repository check delegates here. That check reads `FAMILIES`
 *   against the checkout's manifests and cannot reach a branch that requires mutating `FAMILIES`, so the declaration's
 *   internal consistency is asserted at this end.
 *
 *   The routing assertions are the ones that would break silently. `familyForSegment` reads families in declaration
 *   order, so two families claiming one script would make the order decide which graph reads a Han line, and every
 *   existing router test would still pass.
 */

import {
	FAMILIES,
	FAMILY_SCRIPTS,
	FAMILY_VOCABULARY_ARTIFACT,
	familyByID,
	FamilyEncoder,
	familyFallbackFor,
	familyForLocale,
	familyForScript,
	routeFamilyForText,
	RouteSource,
} from "@mailwoman/neural"
import { scriptFamilyBase } from "@mailwoman/neural/char-encoder"
import { describe, expect, it } from "vitest"

describe("the family registry", () => {
	it("gives every locale exactly one family", () => {
		const seen = new Map<string, string>()

		for (const family of FAMILIES) {
			for (const locale of family.locales) {
				expect(seen.get(locale), `\`${locale}\` is claimed twice`).toBeUndefined()

				seen.set(locale, family.family)
			}
		}
	})

	it("gives every declared language exactly one family", () => {
		const seen = new Map<string, string>()

		for (const family of FAMILIES) {
			for (const language of family.languages ?? []) {
				expect(seen.get(language), `\`${language}\` is claimed twice`).toBeUndefined()

				seen.set(language, family.family)
			}
		}
	})

	it("keeps a claimed language clear of another family's packaged locales", () => {
		// The packaged lookup runs first, so a language claimed by one family while another packages
		// a locale in it would make the language claim cover nothing and the two paths disagree.
		for (const family of FAMILIES) {
			for (const language of family.languages ?? []) {
				for (const other of FAMILIES) {
					if (other.family === family.family) continue

					const clash = other.locales.filter((locale) => locale.split("-")[0] === language)

					expect(clash, `${other.family} packages ${language} while ${family.family} claims it`).toEqual([])
				}
			}
		}
	})

	it("gives every routing script exactly one family", () => {
		const seen = new Map<string, string>()

		for (const family of FAMILIES) {
			for (const script of family.routingScripts ?? []) {
				expect(seen.get(script), `\`${script}\` routes to two families`).toBeUndefined()

				seen.set(script, family.family)
			}
		}
	})

	it("names each family's own id among the locales it serves", () => {
		for (const family of FAMILIES) {
			expect(family.locales).toContain(family.family)
		}
	})

	it("declares a vocabulary artifact for every encoder in use", () => {
		for (const family of FAMILIES) {
			expect(FAMILY_VOCABULARY_ARTIFACT[family.encoder]).toBeTruthy()
		}
	})

	it("resolves a locale, an id and a script to the same family", () => {
		expect(familyForLocale("en-GB")?.family).toBe("en-us")
		expect(familyForLocale("ja-jp")?.family).toBe("cjk")
		expect(familyByID("cjk")?.encoder).toBe(FamilyEncoder.Char)
		expect(familyByID("en-us")?.encoder).toBe(FamilyEncoder.SentencePiece)
		expect(familyForScript("Hang")?.family).toBe("cjk")
	})

	it("answers undefined for a locale no family serves, rather than defaulting to Latin", () => {
		// A locale with no declared graph is a finding the `weights-family` check reports.
		// Reading it as the Latin family would decode its rows on a graph nothing says serves them.
		expect(familyForLocale("pt-br")).toBeUndefined()
		expect(familyForScript("Cyrl")).toBeUndefined()
	})

	it("serves a language's unpackaged locales, so ko-KR and zh-TW reach the character family", () => {
		// These three ship no weights package. Listing only the packaged locales made
		// `familyForLocale` answer undefined while `scriptFamilyBase` answered `cjk` —
		// two declarations of one fact, disagreeing.
		for (const locale of ["ko-KR", "zh-TW", "zh-HK", "ja"]) {
			expect(familyForLocale(locale)?.family, locale).toBe("cjk")
		}
	})
})

describe("familyFallbackFor", () => {
	it("answers the family a locale falls back to when it packages no graph", () => {
		expect(familyFallbackFor("ja-JP")).toBe("cjk")
		expect(familyFallbackFor("ko-KR")).toBe("cjk")
		expect(familyFallbackFor("zh-TW")).toBe("cjk")
	})

	it("answers undefined for the three cases that are not a fallback", () => {
		// A family id resolves to itself, so it falls back to nothing.
		expect(familyFallbackFor("cjk")).toBeUndefined()
		expect(familyFallbackFor("en-us")).toBeUndefined()
		// A Latin overlay names its base in its manifest, so resolution follows `mailwoman.baseWeights`
		// rather than a script rule. Answering here would give resolution two sources for one fact.
		expect(familyFallbackFor("en-GB")).toBeUndefined()
		expect(familyFallbackFor("fr-FR")).toBeUndefined()
		// No family claims it.
		expect(familyFallbackFor("pt-BR")).toBeUndefined()
	})

	it("agrees with scriptFamilyBase, which delegates to it", () => {
		for (const locale of ["ja-JP", "zh-CN", "zh-TW", "zh-HK", "ko-KR", "en-US", "en-GB", "cjk", "ja", "ko", "pt-BR"]) {
			expect(scriptFamilyBase(locale), locale).toBe(familyFallbackFor(locale))
		}
	})

	it("routes no Latin script, because the Latin family declares no predicate", () => {
		expect(FAMILY_SCRIPTS.has("Latn")).toBe(false)
		expect([...FAMILY_SCRIPTS].toSorted()).toEqual(["Hang", "Hani", "Hira", "Kana"])
	})
})

describe("routeFamilyForText", () => {
	it("reports the whole-input script reading that named the family", () => {
		expect(routeFamilyForText("富山県中新川郡上市町大岩148-7")).toMatchObject({
			family: "cjk",
			source: RouteSource.Script,
		})
	})

	it("reports the segment reading for a Han line beside Latin segments", () => {
		expect(routeFamilyForText("逊克二分场四队, HEILONGJIANG, CHINA")).toMatchObject({
			family: "cjk",
			source: RouteSource.ScriptSegment,
		})
	})

	it("carries the reason when no family claims the input", () => {
		const decision = routeFamilyForText("1 Riverlight Quay, Nine Elms Lane, London SW11 8AY")

		expect(decision.family).toBeUndefined()
		expect(decision.source).toBe(RouteSource.Caller)
		expect(decision.abstainedBecause).toBeTruthy()
	})
})
