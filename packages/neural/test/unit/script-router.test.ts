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
import { type ParseOpts, type RoutableClassifier, ScriptRoutedClassifier, scriptFamilyForText } from "@mailwoman/neural"
import { describe, expect, it, vi } from "vitest"

function stubClassifier(name: string, encoder: "sentencepiece" | "char") {
	const tree = (raw: string): AddressTree => ({ raw, roots: [] })

	return {
		encoder,
		parse: vi.fn(async (text: string): Promise<AddressTree> => tree(`${name}:${text}`)),
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
