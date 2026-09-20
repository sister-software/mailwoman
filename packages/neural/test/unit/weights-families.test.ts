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
	familyForLocale,
	familyForScript,
	routeFamilyForText,
	RouteSource,
} from "@mailwoman/neural"
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
		// A locale with no declared graph is a finding the `weights-family` check reports. Reading it as the Latin family
		// would decode its rows on a graph nothing says serves them.
		expect(familyForLocale("pt-br")).toBeUndefined()
		expect(familyForScript("Cyrl")).toBeUndefined()
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
