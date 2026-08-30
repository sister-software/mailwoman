/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The source-conflict gate, and the baseline it is measured against.
 *
 *   The property under test is the DISTINCTION the gate exists to draw: fourteen countries are two-source
 *   today because someone traded duplication for coverage, and a fifteenth appearing is an accident. A gate
 *   that refused all multi-source countries would refuse the trade; one that accepted all of them would
 *   never catch the accident. Both failures print a clean result.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { planCountryMove, servingSources } from "mailwoman/gazetteer-pipeline/country-plan"
import {
	ACCEPTED_TWO_SOURCE_COUNTRIES,
	AdminSource,
	countrySourceMap,
	sourceConflicts,
	sourceSentence,
} from "mailwoman/gazetteer-pipeline/country-sources"
import {
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	DEFAULT_WOF_PRIORITY_COUNTRIES,
} from "mailwoman/gazetteer-pipeline/defaults"
import { describe, expect, it } from "vitest"

const LIVE = {
	wofCountries: DEFAULT_WOF_PRIORITY_COUNTRIES as readonly string[],
	overtureCountries: DEFAULT_OVERTURE_COUNTRIES as readonly string[],
	geonamesCountries: DEFAULT_GEONAMES_COUNTRIES as readonly string[],
}

describe("the shipped recipe", () => {
	it("has no UNRECORDED multi-source country", () => {
		// The regression this guards: a country cloned as a WOF repo, or moved between lists, without being
		// removed from the one that served it. `verifyAdmin` tests floors, so the duplication moves every gate
		// number in the passing direction and the build ships.
		const conflicts = sourceConflicts(countrySourceMap(LIVE))

		expect(conflicts.map((c) => `${c.country}: ${c.sources.join("+")}`)).toEqual([])
	})

	it("still matches the measured baseline exactly", () => {
		// Measured 2026-08-17 against both the lists and admin-global-priority.db: 14 two-source countries, all
		// Overture + GeoNames. If this drifts, the baseline is stale and the number in the docstring is a
		// claim nobody re-measured.
		const multi = countrySourceMap(LIVE).filter((e) => e.sources.length > 1)

		expect(multi.map((e) => e.country).toSorted()).toEqual([...ACCEPTED_TWO_SOURCE_COUNTRIES].toSorted())
		expect(multi.every((e) => e.sources.join("+") === "geonames+overture")).toBe(true)
	})

	it("keeps the WOF leg single-source, which is the case the comments warned about", () => {
		const wofServed = countrySourceMap(LIVE).filter((e) => e.sources.includes(AdminSource.WOF))

		expect(wofServed).not.toHaveLength(0)
		expect(wofServed.every((e) => e.sources.length === 1)).toBe(true)
	})
})

describe("sourceConflicts", () => {
	it("refuses a country that gains a THIRD list entry it did not have", () => {
		const conflicts = sourceConflicts(
			countrySourceMap({ wofCountries: [], overtureCountries: ["ZZ"], geonamesCountries: ["ZZ"] })
		)

		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]!.reason).toContain("baseline does not record")
	})

	it("accepts a baseline country, because that trade was measured", () => {
		// CZ: 9,800 of its 11,904 GeoNames names are already in Overture. Duplication, and deliberate — FI in
		// the same set gains ~12,000 names Overture lacks, so dropping the fold is a coverage decision.
		expect(
			sourceConflicts(countrySourceMap({ wofCountries: [], overtureCountries: ["CZ"], geonamesCountries: ["CZ"] }))
		).toEqual([])
	})

	it("refuses a WOF clone that keeps its old list entry, EVEN for a baseline country", () => {
		// The #267 case, and the reason the WOF check ignores the baseline: every accepted entry is
		// Overture + GeoNames, so WOF appearing means a clone landed and the list was never edited.
		const conflicts = sourceConflicts(
			countrySourceMap({ wofCountries: ["CZ"], overtureCountries: ["CZ"], geonamesCountries: [] })
		)

		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]!.reason).toContain("verifyAdmin tests FLOORS")
	})

	it("passes a country that MOVED cleanly — added to one list, removed from the other", () => {
		expect(
			sourceConflicts(countrySourceMap({ wofCountries: ["TR"], overtureCountries: [], geonamesCountries: [] }))
		).toEqual([])
	})

	it("normalizes case, so a lowercase list entry cannot hide a conflict", () => {
		const conflicts = sourceConflicts(
			countrySourceMap({ wofCountries: ["tr"], overtureCountries: ["TR"], geonamesCountries: [] })
		)

		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]!.country).toBe("TR")
	})
})

describe("sourceSentence", () => {
	it("names the unrecorded count, not just the multi-source count", () => {
		const sources = countrySourceMap({ wofCountries: [], overtureCountries: ["ZZ"], geonamesCountries: ["ZZ"] })

		expect(sourceSentence(sources, sourceConflicts(sources))).toContain("1 UNRECORDED")
	})

	it("says 'none unrecorded' rather than going quiet when the recipe is clean", () => {
		const sources = countrySourceMap(LIVE)

		expect(sourceSentence(sources, sourceConflicts(sources))).toContain("none unrecorded")
	})
})

describe("the id-band literals in country-plan.ts", () => {
	it("agree with the folds that mint them", async () => {
		// `censusForCountry` spells the boundaries as SQL literals because a query cannot import a constant.
		// This is what stops that duplication from drifting: a fold that moves its base moves this test.
		const { OVERTURE_ID_BASE } = await import("mailwoman/gazetteer-pipeline/admin/fold-overture")
		const { GEONAMES_ID_BASE } = await import("@mailwoman/resolver-wof-sqlite/geonames-aliases")
		const source = await readLocalTextFile(new URL("../../../gazetteer-pipeline/country-plan.ts", import.meta.url))

		expect(source).toContain(
			`const OVERTURE_BAND_START = ${OVERTURE_ID_BASE.toLocaleString("en-US").replaceAll(",", "_")}`
		)

		expect(source).toContain(
			`const GEONAMES_BAND_START = ${GEONAMES_ID_BASE.toLocaleString("en-US").replaceAll(",", "_")}`
		)
	})
})

describe("planCountryMove", () => {
	const census = (over: number, geo: number, wof = 0) => ({ country: "TR", wof, overture: over, geonames: geo })

	it("writes BOTH halves of a move — add to the target, remove from the source", () => {
		// The half nothing enforced. Adding a country by cloning is half the job; the other half is removing
		// it from whichever list serves it today, and the build ships either way because verifyAdmin tests floors.
		const plan = planCountryMove({
			country: "tr",
			target: AdminSource.WOF,
			census: census(46_986, 0),
			repos: [{ name: "whosonfirst-data-admin-tr", packedKB: 83_400, exists: true }],
		})

		expect(plan.edits.map((e) => `${e.action} ${e.list}`)).toEqual([
			"add DEFAULT_WOF_PRIORITY_COUNTRIES",
			"remove DEFAULT_OVERTURE_COUNTRIES",
		])

		expect(plan.blockers).toEqual([])
	})

	it("removes from EVERY current source, not just the largest", () => {
		const plan = planCountryMove({
			country: "PL",
			target: AdminSource.WOF,
			census: { country: "PL", wof: 0, overture: 106_849, geonames: 47_882 },
			repos: [{ name: "whosonfirst-data-admin-pl", exists: true }],
		})

		expect(plan.edits.filter((e) => e.action === "remove").map((e) => e.list)).toEqual([
			"DEFAULT_OVERTURE_COUNTRIES",
			"DEFAULT_GEONAMES_COUNTRIES",
		])
	})

	it("multiplies the packed size out to the checkout cost", () => {
		// GitHub reports packed size. Quoting it is how 65 GB arrived unannounced; a --countries tr sync
		// reported 83.4 MB and wrote 633 MB.
		const plan = planCountryMove({
			country: "TR",
			target: AdminSource.WOF,
			census: census(46_986, 0),
			repos: [{ name: "whosonfirst-data-admin-tr", packedKB: 83_400, exists: true }],
		})

		expect(plan.repos[0]!.checkoutKB).toBe(83_400 * 7)
	})

	it("blocks when no WOF repository exists — the country has no WOF path", () => {
		const plan = planCountryMove({
			country: "ZZ",
			target: AdminSource.WOF,
			census: census(10, 0),
			repos: [{ name: "whosonfirst-data-admin-zz", exists: false }],
		})

		expect(plan.blockers[0]).toContain("No WOF repository exists")
	})

	it("blocks a country with no rows at all, because that is a coverage change not a source change", () => {
		const plan = planCountryMove({
			country: "ZZ",
			target: AdminSource.WOF,
			census: census(0, 0),
			repos: [{ name: "whosonfirst-data-admin-zz", exists: true }],
		})

		expect(plan.blockers[0]).toContain("nothing to move FROM")
		expect(plan.blockers[0]).toContain("verify-baseline")
	})

	it("orders the current sources by size, so the move names what it is moving away from", () => {
		expect(servingSources({ country: "FI", wof: 0, overture: 11_709, geonames: 29_235 })).toEqual([
			AdminSource.GeoNames,
			AdminSource.Overture,
		])
	})
})

describe("planCountryMove — a move that is already done", () => {
	it("plans nothing for a country the target already serves", () => {
		// US is WOF-served with 259,485 rows. An "add DEFAULT_WOF_PRIORITY_COUNTRIES" here would have a reader
		// edit a list the country is already on, so the plan would be describing work that is done.
		const plan = planCountryMove({
			country: "US",
			target: AdminSource.WOF,
			census: { country: "US", wof: 259_485, overture: 0, geonames: 0 },
			repos: [{ name: "whosonfirst-data-admin-us", exists: true }],
		})

		expect(plan.edits).toEqual([])
		expect(plan.blockers).toEqual([])
	})
})
