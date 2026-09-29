/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The required case grades place identity off the resolved place rather than the echoed query span, the
 *   confusion that would make the whole check decorative.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { checkCase, componentOf, scriptRenderings } from "mailwoman/eval-harness/gauntlet/check-case"
import type { GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import type { GauntletCaseTable } from "mailwoman/eval-harness/gauntlet/schema"
import { describe, expect, it } from "vitest"

/**
 * Every check opts in per row, so a stored case with no assertion must always pass.
 */
function storedCase(over: Partial<GauntletCaseTable> = {}): GauntletCaseTable {
	return {
		id: "xx-sample",
		input: "Gaborone",
		source: "manual",
		address_kind: "bare_city_global",
		country: "XX",
		status: "pass",
		expect_components: null,
		expect_component_renderings: null,
		expect_place_id: null,
		expect_place_name: null,
		expect_lat: null,
		expect_lon: null,
		expect_tolerance_m: null,
		expect_tier: null,
		default_country: null,
		locale: null,
		expect_abstain: null,
		added_at: "2026-08-06",
		bug_ref: null,
		note: null,
		ablation_expect: null,
		...over,
	}
}

function result(over: Partial<GauntletResult> = {}): GauntletResult {
	return {
		components: {},
		lat: null,
		lon: null,
		tier: "admin",
		locality: null,
		region: null,
		country: null,
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		postcode_country_scope: null,
		hierarchy: [],
		...over,
	}
}

describe("the coordinate / tier / component checks", () => {
	it("asserts nothing on a case that pins nothing", () => {
		expect(checkCase(storedCase(), result())).toEqual([])
	})

	it("passes a coordinate inside the case tolerance", () => {
		const c = storedCase({ expect_lat: -24.658, expect_lon: 25.9077, expect_tolerance_m: 25_000 })

		expect(checkCase(c, result({ lat: -24.65451, lon: 25.90859 }))).toEqual([])
	})

	it("fails a coordinate outside it, naming the distance", () => {
		const c = storedCase({ expect_lat: -24.658, expect_lon: 25.9077, expect_tolerance_m: 25_000 })
		const issues = checkCase(c, result({ lat: 46.9, lon: 15.3 }))

		expect(issues).toHaveLength(1)
		expect(issues[0]).toMatch(/^coord \d+\.\d\dkm off \(tol 25000m\)$/)
	})

	it("reports an unresolved coordinate as unresolved, not as a number", () => {
		const c = storedCase({ expect_lat: 1, expect_lon: 1 })

		expect(checkCase(c, result())).toEqual(["coord unresolved (tol 5000m)"])
	})

	it("fails a drifted tier", () => {
		const c = storedCase({ expect_tier: "address_point" })

		expect(checkCase(c, result({ tier: "admin" }))).toEqual(["tier admin ≠ address_point"])
	})

	it("compares components case-insensitively", () => {
		const c = storedCase({ expect_components: stringifyJSON({ locality: "gaborone" }) })

		expect(checkCase(c, result({ locality: "Gaborone" }))).toEqual([])
	})

	it("surfaces a corrupt expect_components row as a case issue, not a throw", () => {
		const c = storedCase({ expect_components: "{not json" })

		expect(checkCase(c, result())).toEqual(["expect_components is not valid JSON (corrupt regression.db row?)"])
	})

	it("throws on an expect_components key with no result mapping", () => {
		const c = storedCase({ expect_components: stringifyJSON({ borough: "Brooklyn" }) })

		expect(() => checkCase(c, result())).toThrow(/extend componentOf/)
	})

	it("maps every component key the corpus can assert", () => {
		const r = result({
			components: { block: "3丁目", municipality: "高山市" },
			venue: "Big Hall",
			unit: "Apt 4",
			dependent_locality: "Abbey Hey",
		})

		expect(componentOf(r, "venue")).toBe("Big Hall")
		expect(componentOf(r, "unit")).toBe("Apt 4")
		expect(componentOf(r, "dependent_locality")).toBe("Abbey Hey")
		expect(componentOf(r, "block")).toBe("3丁目")
		expect(componentOf(r, "municipality")).toBe("高山市")
	})
})

describe("the place-identity check (#1507)", () => {
	it("passes when the resolved place matches the asserted name", () => {
		const c = storedCase({ expect_place_name: "Gaborone" })

		const r = result({
			locality: "Gaborone",
			hierarchy: [{ tag: "locality", name: "Gaborone", placeID: "wof:9000000121151" }],
		})

		expect(checkCase(c, r)).toEqual([])
	})

	it("grades place identity off the RESOLVED place, not the echoed query span", () => {
		// The parse can be perfect and `locality` echo it while the resolver returned
		// another place, so only reading `hierarchy[0].name` sees the failure.
		const c = storedCase({
			expect_components: stringifyJSON({ locality: "Gaborone" }),
			expect_place_name: "Gaborone",
		})

		const r = result({
			locality: "Gaborone",
			hierarchy: [{ tag: "locality", name: "Aichegg", placeID: "wof:9000000121151" }],
		})

		expect(checkCase(c, r)).toEqual([`place name "Aichegg" ≠ "Gaborone"`])
	})

	it("fails a mismatched place id exactly, without case folding", () => {
		const c = storedCase({ expect_place_id: "wof:101750367" })
		const r = result({ hierarchy: [{ tag: "locality", name: "Gaborone", placeID: "WOF:101750367" }] })

		expect(checkCase(c, r)).toEqual([`place id "WOF:101750367" ≠ "wof:101750367"`])
	})

	it("reports an undecorated node's absent id rather than pretending it matched", () => {
		const c = storedCase({ expect_place_id: "wof:101750367" })
		const r = result({ hierarchy: [{ tag: "locality", name: "Gaborone" }] })

		expect(checkCase(c, r)).toEqual([`place id "null" ≠ "wof:101750367"`])
	})

	it("fails an empty hierarchy as unresolved — absence, not a pass", () => {
		const c = storedCase({ expect_place_name: "Gaborone" })

		expect(checkCase(c, result())).toEqual([`place unresolved (hierarchy empty) ≠ "Gaborone"`])
	})

	it("reads the MOST SPECIFIC node when the chain resolved several", () => {
		const c = storedCase({ expect_place_name: "Gaborone" })

		const r = result({
			hierarchy: [
				{ tag: "locality", name: "Gaborone", placeID: "wof:101750367" },
				{ tag: "country", name: "Botswana", placeID: "wof:85632505" },
			],
		})

		expect(checkCase(c, r)).toEqual([])
	})

	it("stays silent for the rows that assert neither — the zero-adoption case", () => {
		const r = result({ hierarchy: [{ tag: "locality", name: "Aichegg", placeID: "wof:9000000121151" }] })

		expect(checkCase(storedCase(), r)).toEqual([])
	})
})

describe("the component check is exact — multi-script truth is a per-row opt-in (#34)", () => {
	// Dual-script truth is a per-row `expect_component_renderings` opt-in, never a
	// global relaxation that lets a cross-tag bleed grade as a pass.
	it("fails a cross-script bleed against a plain expect_components truth — the Manchester case", () => {
		// With no rendering interface on the row, a locality that swallowed the CJK venue next door must fail.
		const c = storedCase({ expect_components: stringifyJSON({ locality: "Manchester" }) })

		expect(checkCase(c, result({ locality: "四季酒家 Manchester" }))).toEqual([
			`locality "四季酒家 Manchester" ≠ "Manchester"`,
		])
	})

	it("no longer accepts a dual-script span against a truth freezing one rendering — that is the opt-in's job", () => {
		const c = storedCase({ expect_components: stringifyJSON({ venue: "Gandantegchinlen Monastery" }) })

		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery / Гандантэгчинлэн хийд" }))).toHaveLength(1)
	})

	it("passes a rendering interface when the span carries every listed rendering", () => {
		const c = storedCase({
			expect_component_renderings: stringifyJSON({
				venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"],
			}),
		})

		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery / Гандантэгчинлэн хийд" }))).toEqual([])
	})

	it("passes the bleed-shaped got too, once an interface SAYS both elements belong — explicit, not global", () => {
		const c = storedCase({ expect_component_renderings: stringifyJSON({ locality: ["四季酒家", "Manchester"] }) })

		expect(checkCase(c, result({ locality: "四季酒家 Manchester" }))).toEqual([])
	})

	it("fails a span carrying only ONE of two required renderings, naming the missing one", () => {
		const c = storedCase({
			expect_component_renderings: stringifyJSON({
				venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"],
			}),
		})

		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery" }))).toEqual([
			`venue "Gandantegchinlen Monastery" missing rendering(s) "Гандантэгчинлэн хийд"`,
		])
	})

	it("folds case inside the interface, exactly as the exact path does", () => {
		const c = storedCase({
			expect_component_renderings: stringifyJSON({ locality: ["ulaanbaatar", "улаанбаатар"] }),
		})

		expect(checkCase(c, result({ locality: "Улаанбаатар, Ulaanbaatar" }))).toEqual([])
	})

	it("asserts nothing beyond the listed renderings — an extra rendering rides along free", () => {
		const c = storedCase({
			expect_component_renderings: stringifyJSON({ locality: ["Ulaanbaatar", "Улаанбаатар"] }),
		})

		expect(checkCase(c, result({ locality: "Улаанбаатар / Ulaanbaatar / ウランバートル" }))).toEqual([])
	})

	it("lets an interface key supersede the same key in expect_components", () => {
		// An interface key supersedes the same key in `expect_components`
		// while leaving unrelated exact keys to grade through it.
		const c = storedCase({
			expect_components: stringifyJSON({ venue: "Gandantegchinlen Monastery", postcode: "16040" }),
			expect_component_renderings: stringifyJSON({
				venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"],
			}),
		})

		const dual = result({ venue: "Gandantegchinlen Monastery / Гандантэгчинлэн хийд", postcode: "16040" })

		expect(checkCase(c, dual)).toEqual([])
		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery", postcode: "16040" }))).toHaveLength(1)

		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery / Гандантэгчинлэн хийд" }))).toEqual([
			`postcode "null" ≠ "16040"`,
		])
	})

	it("surfaces a corrupt expect_component_renderings row as a case issue, not a throw", () => {
		const c = storedCase({ expect_component_renderings: "{not json" })

		expect(checkCase(c, result())).toEqual([
			"expect_component_renderings is not valid JSON (corrupt regression.db row?)",
		])
	})

	it("throws on an empty rendering list — an authoring bug the seed schema refuses upstream", () => {
		const c = storedCase({ expect_component_renderings: stringifyJSON({ venue: [] }) })

		expect(() => checkCase(c, result())).toThrow(/non-empty string array/)
	})

	it("throws on a non-array interface value for the same reason", () => {
		const c = storedCase({ expect_component_renderings: stringifyJSON({ venue: "Гандантэгчинлэн хийд" }) })

		expect(() => checkCase(c, result())).toThrow(/non-empty string array/)
	})

	it("leaves a SAME-script concatenation failing — the plus-code row's error must stay visible", () => {
		// A model that types the Open Location Code as `postcode` emits two spans next to the real 14200.
		// With no interface listing them, the exact comparison must keep failing.
		const c = storedCase({ expect_components: stringifyJSON({ postcode: "14200" }) })

		expect(checkCase(c, result({ postcode: "WWF9+6H6 14200" }))).toEqual([`postcode "WWF9+6H6 14200" ≠ "14200"`])
	})

	it("does not let a mono-script multi-word truth be satisfied by one of its words", () => {
		const c = storedCase({ expect_components: stringifyJSON({ locality: "Chicago" }) })

		expect(checkCase(c, result({ locality: "Springfield Chicago" }))).toHaveLength(1)
	})
})

describe("scriptRenderings", () => {
	it("splits a slash-joined dual-script value into one rendering per script", () => {
		expect(scriptRenderings("Gandantegchinlen Monastery / Гандантэгчинлэн хийд")).toEqual([
			"Gandantegchinlen Monastery",
			"Гандантэгчинлэн хийд",
		])
	})

	it("keeps digits and punctuation INSIDE a rendering when letters of one script flank them", () => {
		expect(scriptRenderings("ХУД - 15 хороо, Ulaanbaatar")).toEqual(["ХУД - 15 хороо", "Ulaanbaatar"])
	})

	it("returns a single rendering for a mono-script value — nothing for a two-rendering interface to accept", () => {
		// A rendering starts and ends at a letter, so the trailing digits fall off — harmless, because a
		// mono-script value can never contain the two renderings a dual-script interface requires.
		expect(scriptRenderings("WWF9+6H6 14200")).toEqual(["WWF9+6H"])
		expect(scriptRenderings("Springfield Chicago")).toEqual(["Springfield Chicago"])
	})

	it("treats Han/kana as ONE family so a Japanese rendering is not shredded", () => {
		expect(scriptRenderings("東京都渋谷区 Tokyo")).toEqual(["東京都渋谷区", "Tokyo"])
		expect(scriptRenderings("表参道ヒルズ ゼルコバテラス")).toEqual(["表参道ヒルズ ゼルコバテラス"])
	})

	it("returns nothing for a value with no letters at all", () => {
		expect(scriptRenderings("16040")).toEqual([])
	})
})
