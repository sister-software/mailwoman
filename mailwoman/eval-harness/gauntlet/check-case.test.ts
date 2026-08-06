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

import { checkCase, componentOf } from "./check-case.ts"
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
		const r = result({ venue: "Big Hall", unit: "Apt 4", dependent_locality: "Abbey Hey" })

		expect(componentOf(r, "venue")).toBe("Big Hall")
		expect(componentOf(r, "unit")).toBe("Apt 4")
		expect(componentOf(r, "dependent_locality")).toBe("Abbey Hey")
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
