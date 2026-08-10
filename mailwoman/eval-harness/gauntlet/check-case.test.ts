/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The grader's gate. Every assertion the curated regression layer makes is decided here, and until
 *   2026-08-06 none of it was reachable without the ~9 GB shard set — which is how two stored expectation
 *   columns (`expect_place_id`, `expect_place_name`) went the corpus's whole life unread (#1507).
 *
 *   The load-bearing case is `grades place identity off the RESOLVED place, not the echoed query span`: it
 *   pins the exact confusion that would make this whole gate decorative.
 */

import { describe, expect, it } from "vitest"

import { checkCase, componentOf, scriptRenderings } from "./check-case.ts"
import type { GauntletResult } from "./harness.ts"
import type { GauntletCaseTable } from "./schema.ts"

/**
 * A stored case with nothing asserted — every gate opts in per row, so this one must always pass.
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

describe("the coordinate / tier / component gates", () => {
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
		const c = storedCase({ expect_components: JSON.stringify({ locality: "gaborone" }) })

		expect(checkCase(c, result({ locality: "Gaborone" }))).toEqual([])
	})

	it("surfaces a corrupt expect_components row as a case issue, not a throw", () => {
		const c = storedCase({ expect_components: "{not json" })

		expect(checkCase(c, result())).toEqual(["expect_components is not valid JSON (corrupt regression.db row?)"])
	})

	it("throws on an expect_components key with no result mapping", () => {
		const c = storedCase({ expect_components: JSON.stringify({ borough: "Brooklyn" }) })

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

describe("the place-identity gate (#1507)", () => {
	it("passes when the resolved place matches the asserted name", () => {
		const c = storedCase({ expect_place_name: "Gaborone" })

		const r = result({
			locality: "Gaborone",
			hierarchy: [{ tag: "locality", name: "Gaborone", placeID: "wof:9000000121151" }],
		})

		expect(checkCase(c, r)).toEqual([])
	})

	it("grades place identity off the RESOLVED place, not the echoed query span", () => {
		// The Gaborone class, verbatim: the parse is perfect and `locality` echoes it, while the resolver
		// returned an Austrian hamlet. `expect_components.locality` is green on this result; only the place
		// gate can see the failure — which is what makes reading `hierarchy[0].name` load-bearing.
		const c = storedCase({
			expect_components: JSON.stringify({ locality: "Gaborone" }),
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

describe("the component gate is exact — multi-script truth is a per-row opt-in (#34)", () => {
	// The 2026-08-10 global relaxation (any dual-script got satisfied a truth freezing one rendering) let a
	// cross-tag bleed grade as a pass, so review converted it into the `expect_component_renderings` opt-in.
	// The first two tests pin the reversal; the rest pin the opt-in contract itself.
	it("fails a cross-script bleed against a plain expect_components truth — the Manchester case", () => {
		// The exposure the global relaxation disclosed: a locality that swallowed the CJK venue next door
		// graded as a pass. With no rendering contract on the row, this must FAIL again.
		const c = storedCase({ expect_components: JSON.stringify({ locality: "Manchester" }) })

		expect(checkCase(c, result({ locality: "四季酒家 Manchester" }))).toEqual([
			`locality "四季酒家 Manchester" ≠ "Manchester"`,
		])
	})

	it("no longer accepts a dual-script span against a truth freezing one rendering — that is the opt-in's job", () => {
		const c = storedCase({ expect_components: JSON.stringify({ venue: "Gandantegchinlen Monastery" }) })

		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery / Гандантэгчинлэн хийд" }))).toHaveLength(1)
	})

	it("passes a rendering contract when the span carries every listed rendering", () => {
		const c = storedCase({
			expect_component_renderings: JSON.stringify({
				venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"],
			}),
		})

		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery / Гандантэгчинлэн хийд" }))).toEqual([])
	})

	it("passes the bleed-shaped got too, once a contract SAYS both elements belong — explicit, not global", () => {
		const c = storedCase({ expect_component_renderings: JSON.stringify({ locality: ["四季酒家", "Manchester"] }) })

		expect(checkCase(c, result({ locality: "四季酒家 Manchester" }))).toEqual([])
	})

	it("fails a span carrying only ONE of two required renderings, naming the missing one", () => {
		const c = storedCase({
			expect_component_renderings: JSON.stringify({
				venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"],
			}),
		})

		expect(checkCase(c, result({ venue: "Gandantegchinlen Monastery" }))).toEqual([
			`venue "Gandantegchinlen Monastery" missing rendering(s) "Гандантэгчинлэн хийд"`,
		])
	})

	it("folds case inside the contract, exactly as the exact path does", () => {
		const c = storedCase({
			expect_component_renderings: JSON.stringify({ locality: ["ulaanbaatar", "улаанбаатар"] }),
		})

		expect(checkCase(c, result({ locality: "Улаанбаатар, Ulaanbaatar" }))).toEqual([])
	})

	it("asserts nothing beyond the listed renderings — an extra rendering rides along free", () => {
		const c = storedCase({
			expect_component_renderings: JSON.stringify({ locality: ["Ulaanbaatar", "Улаанбаатар"] }),
		})

		expect(checkCase(c, result({ locality: "Улаанбаатар / Ulaanbaatar / ウランバートル" }))).toEqual([])
	})

	it("lets a contract key supersede the same key in expect_components", () => {
		// expect_components freezes the Latin half; the contract requires both. The dual span passes (the
		// superseded exact comparison would have failed it), the frozen half alone fails (the contract owns
		// the key), and an unrelated exact key on the same row still grades through expect_components.
		const c = storedCase({
			expect_components: JSON.stringify({ venue: "Gandantegchinlen Monastery", postcode: "16040" }),
			expect_component_renderings: JSON.stringify({
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
		const c = storedCase({ expect_component_renderings: JSON.stringify({ venue: [] }) })

		expect(() => checkCase(c, result())).toThrow(/non-empty string array/)
	})

	it("throws on a non-array contract value for the same reason", () => {
		const c = storedCase({ expect_component_renderings: JSON.stringify({ venue: "Гандантэгчинлэн хийд" }) })

		expect(() => checkCase(c, result())).toThrow(/non-empty string array/)
	})

	it("leaves a SAME-script concatenation failing — the plus-code row's error must stay visible", () => {
		// mn-ws-national-university-pluscode-sbd-6-khoroo: a model that types the Open Location Code as
		// `postcode` emits two postcode spans next to the real 14200. No contract lists them, so the exact
		// comparison keeps failing (that visibility is the row's point).
		const c = storedCase({ expect_components: JSON.stringify({ postcode: "14200" }) })

		expect(checkCase(c, result({ postcode: "WWF9+6H6 14200" }))).toEqual([`postcode "WWF9+6H6 14200" ≠ "14200"`])
	})

	it("does not let a mono-script multi-word truth be satisfied by one of its words", () => {
		const c = storedCase({ expect_components: JSON.stringify({ locality: "Chicago" }) })

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

	it("returns a single rendering for a mono-script value — nothing for a two-rendering contract to accept", () => {
		// A rendering starts and ends at a LETTER, so the trailing digits fall off — harmless, because a
		// mono-script value can never contain the two renderings a dual-script contract requires.
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
