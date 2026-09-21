/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The script-routed classifier over stub classifiers: a Latin line stays on the primary, a kanji or Hangul line
 *   runs on the family loaded once, a family whose load fails degrades to the primary with one report, a
 *   character-path primary is never re-routed, and a routed parse drops the primary's gazetteer priors.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import {
	carriesFamilySegment,
	type ParseOpts,
	type RoutableClassifier,
	routeFamilyWithLeadingRun,
	ScriptRoutedClassifier,
	scriptFamilyForText,
} from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"
import { describe, expect, it, vi } from "vitest"

function stubClassifier(name: string, encoder: "sentencepiece" | "char") {
	const tree = (raw: string): AddressTree => ({ raw, roots: [] })

	return {
		encoder,
		parse: vi.fn<RoutableClassifier["parse"]>(async (text) => tree(`${name}:${text}`)),
		traceParse: vi.fn<RoutableClassifier["traceParse"]>(),
		fstPath: undefined,
		streetMorphologyPath: undefined,
		resolvedWeights: undefined,
		spanGrammar: undefined,
	} satisfies RoutableClassifier
}

describe("scriptFamilyForText", () => {
	it("names the cjk family for kanji, kana and Hangul, and nothing for Latin", () => {
		expect(scriptFamilyForText("富山県中新川郡上市町大岩148-7")).toBe("cjk")
		expect(scriptFamilyForText("りんりん, 〒506-0025 岐阜県高山市天満町3丁目 57")).toBe("cjk")
		expect(scriptFamilyForText("부산광역시 해운대구 반송로 910-1")).toBe("cjk")
		expect(scriptFamilyForText("1 Riverlight Quay, Nine Elms Lane, London SW11 8AY")).toBeUndefined()
	})

	it("names the family for a Han address line beside Latin segments", () => {
		// The whole-input fold answers `mixed` for these, which sent the Han unit to the Latin model as one locality.
		expect(scriptFamilyForText("逊克二分场四队, HEILONGJIANG, CHINA")).toBe("cjk")
		expect(scriptFamilyForText("七分场, LIAONING, CHINA")).toBe("cjk")
		expect(scriptFamilyForText("一零三团七连, xinjiang uyghur")).toBe("cjk")
	})

	it("abstains on a house number or a postcode inside a Han segment rather than disqualifying it", () => {
		expect(carriesFamilySegment(computeQueryShape("六分场七队 100, HUNAN"))).toBe(true)
	})

	it("keeps a Latin line carrying a foreign-script venue name on the primary", () => {
		// These four are what make the segment reading narrower than "any family script
		// in the input": the name shares its segment with the Latin words around it,
		// and the character model reads those by codepoint — `Far East Chinese 口福羊汤`
		// came back as `country: "Chi"`, `region: "Far East"`.
		expect(scriptFamilyForText("Far East Chinese 口福羊汤, 13 Gerrard St, London W1D 5PS")).toBeUndefined()

		expect(
			scriptFamilyForText(
				"Four Seasons Inn四季酒家, New Smithfield Market, Unit, M8, Manchester M11 2WW, United Kingdom"
			)
		).toBeUndefined()

		expect(scriptFamilyForText("SOKCHO 牛者, 6 Rue d'Antin, 75002 Paris")).toBeUndefined()
		expect(scriptFamilyForText("JJAN! 짠 Châtelet, 14 Rue du Pont Neuf, 75001 Paris")).toBeUndefined()
	})

	it("does not reach a Han line separated from its Latin province by whitespace alone", () => {
		// The stated cost of reading commas: this row has no segment of its own.
		// A whitespace reading would reach it and would also re-admit the venue names above.
		expect(scriptFamilyForText("六分场七队 Hunan")).toBeUndefined()
		expect(scriptFamilyForText("一分场一队 Hunan China")).toBeUndefined()
	})
})

describe("routeFamilyWithLeadingRun", () => {
	/**
	 * The four CN board rows the shipped router leaves on the Latin graph.
	 *
	 * Each writes its Han unit and its Latin province in one whitespace-separated run,
	 * so no comma segment is wholly Han and `carriesFamilySegment` abstains.
	 */
	const HAN_LED = [
		"六分场七队 Hunan",
		"红色边疆一分场十一队 Heilongjiang",
		"一分场一队 Hunan China",
		"红花分场十七连 Jiangsu China",
	]

	/**
	 * The four board rows that pass today with Han or Hangul inside a Latin line.
	 *
	 * A reading that moves one of these changes the graph serving a checking row,
	 * and two of them are GB, which `scope.config.json` names in `dRuleProtected`.
	 */
	const LATIN_LED = [
		"JJAN! 짠 Châtelet, 14 Rue du Pont Neuf, 75001 Paris",
		"SOKCHO 牛者, 6 Rue d'Antin, 75002 Paris",
		"Four Seasons Inn四季酒家, New Smithfield Market, Unit, M8, Manchester M11 2WW, United Kingdom",
		"Far East Chinese 口福羊汤, 13 Gerrard St, London W1D 5PS",
	]

	it.each(HAN_LED)("names the character family for a Han-led line the shipped router abstains on: %s", (input) => {
		expect(scriptFamilyForText(input)).toBeUndefined()
		expect(routeFamilyWithLeadingRun(input).family).toBe("cjk")
	})

	it.each(LATIN_LED)("leaves a Latin-led line where the shipped router put it: %s", (input) => {
		expect(routeFamilyWithLeadingRun(input).family).toBe(scriptFamilyForText(input))
	})

	it("keeps the shipped router's answer wherever that router names a family", () => {
		// Tried last and only on an abstention, which is what makes the difference
		// between the two arms exactly the rows the reading adds.
		// A reading that could also change an existing answer would need its own comparison.
		for (const input of ["富山県中新川郡上市町大岩148-7", "逊克二分场四队, HEILONGJIANG, CHINA", "新加坡"]) {
			expect(routeFamilyWithLeadingRun(input).family).toBe(scriptFamilyForText(input))
		}
	})

	it("reaches no input written wholly in Latin script, so the two romaji JP rows stay put", () => {
		for (const input of [
			"4-chōme-12-10 Jingūmae, Shibuya, Tokyo 150-0001, Japan",
			"Rinrin, 3 Chome-57 Tenmanmachi, Takayama, Gifu 506-0025, Japan",
		]) {
			expect(routeFamilyWithLeadingRun(input).family).toBeUndefined()
		}
	})

	it("skips a leading token carrying no script rather than letting it decide", () => {
		// `Zyyy` is the class for a house number or a postal mark.
		// Answering on the first token regardless would make `〒150-0001` decide a route,
		// and the postal mark belongs to no family's script set.
		expect(routeFamilyWithLeadingRun("〒150-0001 東京都渋谷区").family).toBe("cjk")
	})
})

describe("ScriptRoutedClassifier", () => {
	it("keeps a Latin line on the primary and never loads a family for it", async () => {
		const primary = stubClassifier("latin", "sentencepiece")
		const loadFamily = vi.fn(async () => stubClassifier("cjk", "char"))
		const routed = new ScriptRoutedClassifier({ primary, loadFamily })

		const tree = await routed.parse("1 Riverlight Quay, Nine Elms Lane, London SW11 8AY")

		expect(tree.raw).toBe("latin:1 Riverlight Quay, Nine Elms Lane, London SW11 8AY")
		expect(loadFamily).not.toHaveBeenCalled()
		expect(routed.encoder).toBe("sentencepiece")
	})

	it("runs a Hangul line and a kanji line on the family, loaded once", async () => {
		const primary = stubClassifier("latin", "sentencepiece")
		const family = stubClassifier("cjk", "char")
		const loadFamily = vi.fn(async () => family)
		const routed = new ScriptRoutedClassifier({ primary, loadFamily })

		const [korean, japanese] = await Promise.all([
			routed.parse("부산광역시 해운대구 반송로 910-1"),
			routed.parse("富山県中新川郡上市町大岩148-7"),
		])

		expect(korean.raw).toBe("cjk:부산광역시 해운대구 반송로 910-1")
		expect(japanese.raw).toBe("cjk:富山県中新川郡上市町大岩148-7")
		expect(loadFamily).toHaveBeenCalledTimes(1)
		expect(loadFamily).toHaveBeenCalledWith("cjk")
		expect(await routed.forInput("서울특별시 종로구 자하문로 104")).toBe(family)
		expect(primary.parse).not.toHaveBeenCalled()
	})

	it("degrades to the primary when the family cannot load, reporting the family once", async () => {
		const primary = stubClassifier("latin", "sentencepiece")

		const loadFamily = vi.fn(async () => {
			throw new Error("Could not resolve @mailwoman/neural-weights-cjk")
		})

		const onFamilyUnavailable = vi.fn()
		const routed = new ScriptRoutedClassifier({ primary, loadFamily, onFamilyUnavailable })

		expect(await routed.forInput("부산광역시 해운대구 반송로 910-1")).toBe(primary)
		expect(await routed.forInput("富山県中新川郡上市町大岩148-7")).toBe(primary)

		expect(loadFamily).toHaveBeenCalledTimes(1)
		expect(onFamilyUnavailable).toHaveBeenCalledTimes(1)
		expect(onFamilyUnavailable.mock.calls[0]?.[0]).toBe("cjk")
	})

	it("never re-routes a character-path primary", async () => {
		const primary = stubClassifier("cjk-primary", "char")
		const loadFamily = vi.fn(async () => stubClassifier("cjk", "char"))
		const routed = new ScriptRoutedClassifier({ primary, loadFamily })

		expect(await routed.forInput("富山県中新川郡上市町大岩148-7")).toBe(primary)
		expect(await routed.forInput("1 Riverlight Quay, Nine Elms Lane, London SW11 8AY")).toBe(primary)
		expect(loadFamily).not.toHaveBeenCalled()
	})

	it("withholds the primary's gazetteer priors from a routed parse and passes them to the primary's", async () => {
		const primary = stubClassifier("latin", "sentencepiece")
		const family = stubClassifier("cjk", "char")
		const routed = new ScriptRoutedClassifier({ primary, loadFamily: async () => family })
		const opts: ParseOpts = { postcodeRepair: true, fstStreetMorphologyOpts: { biasScale: 2 } }

		await routed.parse("富山県中新川郡上市町大岩148-7", opts)
		await routed.parse("1 Riverlight Quay, Nine Elms Lane, London SW11 8AY", opts)

		expect(family.parse.mock.calls[0]?.[1]).toEqual({ postcodeRepair: true })
		expect(primary.parse.mock.calls[0]?.[1]).toBe(opts)
	})
})
