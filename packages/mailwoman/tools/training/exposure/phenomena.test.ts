/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CLAIM_ARITY, ClaimArity } from "@mailwoman/codex/address/convention-claims"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"
import { describe, expect, test } from "vitest"

import {
	LocateError,
	pairPhenomena,
	PHENOMENON_IDS,
	Row,
	rowFromSpans,
	rowPhenomena,
	spansFromComponents,
} from "./phenomena.ts"

const { pythonText } = await mtfNode()

const canonical = (raw: string, country: string, components: Record<string, string>) =>
	new Row(raw, country, spansFromComponents(pythonText, raw, components))

describe("exposure phenomena", () => {
	test("the ids are the convention claim ids, one of them relational", () => {
		expect(PHENOMENON_IDS).toHaveLength(8)

		expect(PHENOMENON_IDS.filter((id) => CLAIM_ARITY[id] === ClaimArity.Relational)).toEqual([
			"ordering-reverses-with-script",
		])
	})

	test("a streetless premise needs a number and a place and no street", () => {
		const streetless = canonical("12, Ивановка, Тула", "RU", {
			house_number: "12",
			dependent_locality: "Ивановка",
			locality: "Тула",
		})

		expect(rowPhenomena(streetless).get("streetless-premise-identity")).toBe("streetless")
		expect(rowPhenomena(canonical("Тула", "RU", { locality: "Тула" })).has("streetless-premise-identity")).toBe(false)

		expect(
			rowPhenomena(
				canonical("улица Ленина, 12, Тула", "RU", { street: "улица Ленина", house_number: "12", locality: "Тула" })
			).has("streetless-premise-identity")
		).toBe(false)
	})

	test("the order predicates count both orders", () => {
		const found = rowPhenomena(
			canonical("улица Ленина, 12, Тула, 300000", "RU", {
				street: "улица Ленина",
				house_number: "12",
				locality: "Тула",
				postcode: "300000",
			})
		)

		expect(found.get("house-number-precedes-street")).toBe("after")
		expect(found.get("postcode-precedes-locality")).toBe("after")
		expect(found.get("fixed-width-numeric-postcode")).toBe("6-digit")

		const cn = canonical("湖南省长沙市人民路12号", "CN", {
			region: "湖南省",
			locality: "长沙市",
			street: "人民路",
			house_number: "12",
		})

		expect(rowPhenomena(cn).get("largest-unit-first")).toBe("region-first")
	})

	test("subdivisions and planning terms report what matched, and a street holding a term does not count", () => {
		const found = rowPhenomena(
			canonical("Flat 4, 12 Main Road, Sector 12, Gurugram", "IN", {
				unit: "Flat 4",
				house_number: "12",
				street: "Main Road",
				dependent_locality: "Sector 12",
				locality: "Gurugram",
			})
		)

		expect(found.get("premise-subdivision-present")).toBe("unit")
		expect(found.get("planning-word-names-locality")).toBe("sector")

		const road = canonical("12 Sector Road, Gurugram", "IN", {
			house_number: "12",
			street: "Sector Road",
			locality: "Gurugram",
		})

		expect(rowPhenomena(road).has("planning-word-names-locality")).toBe(false)
	})

	test("a planning term inside a longer word is not a term", () => {
		const row = canonical("Blocké 3, Lyon", "FR", { locality: "Blocké 3" })

		expect(rowPhenomena(row).has("planning-word-names-locality")).toBe(false)
	})

	test("a component absent from raw throws rather than measuring fewer components", () => {
		expect(() => spansFromComponents(pythonText, "12 Main Road", { house_number: "12", locality: "Delhi" })).toThrow(
			LocateError
		)
	})

	test("components are found in the case-folded text, in code points, as the Python predicates found them", () => {
		// `ß` folds to `ss`, so offsets after it index the folded text, and `𝔸` is one code point.
		expect(spansFromComponents(pythonText, "Straße 1, 𝔸 Town", { street: "STRASSE", locality: "Town" })).toEqual([
			{ tag: "street", start: 0, end: 7 },
			{ tag: "locality", start: 13, end: 17 },
		])
	})

	test("pairs compare pairwise order and numeric context", () => {
		const native = rowFromSpans(
			"湖南省长沙市人民路12号",
			"CN",
			[0, 3, 6, 9],
			[3, 6, 9, 11],
			["region", "locality", "street", "house_number"]
		)

		const romanized = canonical("12 Renmin Road, Changsha, Hunan", "CN", {
			house_number: "12",
			street: "Renmin Road",
			locality: "Changsha",
			region: "Hunan",
		})

		expect(pairPhenomena(pythonText, native, romanized).get("ordering-reverses-with-script")).toBe("reordered")

		const india = canonical("Lucknow 226001", "IN", { locality: "Lucknow", postcode: "226001" })
		const russia = canonical("Тула, 300000", "RU", { locality: "Тула", postcode: "300000" })

		expect(pairPhenomena(pythonText, india, russia).get("numeric-shape-across-contexts")).toBe("6-digit:IN/RU")
	})

	test("a span triple of unequal lengths is refused", () => {
		expect(() => rowFromSpans("a", "US", [0], [1, 2], ["street"])).toThrow("differs in length")
	})
})
