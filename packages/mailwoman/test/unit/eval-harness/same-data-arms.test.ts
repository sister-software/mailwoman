/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The same-data benchmark's three-row synthetic smoke (#2261): one correct-candidate row, one
 *   contradiction, one withheld gold. It exists to prove the harness catches the two failures that would
 *   otherwise be invisible in a real run.
 *
 *   A replay miss records `error` rather than an abstention: the fixture refused, not the resolver, and the
 *   scorer excludes the row from every metric so the abstention counts stay about the resolver.
 *
 *   An unequal fixture is caught over what the arms read rather than over the file — `assertEqualEvidence`
 *   runs on the receipts the arms carry out of their own runs.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { runBaselineArm, runResolverArm } from "mailwoman/eval-harness/same-data/arms"
import {
	assertEqualEvidence,
	candidatePool,
	canonicalQueryKey,
	SAME_DATA_SCHEMA_VERSION,
	type SameDataCandidate,
	type SameDataFixtureRow,
	type SameDataPanelRow,
} from "mailwoman/eval-harness/same-data/fixture"
import { armMetrics } from "mailwoman/eval-harness/same-data/score"
import { describe, expect, it } from "vitest"

const SPRINGFIELD_IL: SameDataCandidate = {
	id: 101,
	name: "Springfield",
	placetype: "locality",
	country: "US",
	lat: 39.8017,
	lon: -89.6437,
	score: 12,
	population: 114_394,
	exactMatch: true,
}

const SPRINGFIELD_MA: SameDataCandidate = {
	id: 202,
	name: "Springfield",
	placetype: "locality",
	country: "US",
	lat: 42.1015,
	lon: -72.5898,
	score: 11,
	population: 155_929,
	exactMatch: true,
}

function tree(raw: string, value: string): AddressTree {
	return {
		raw,
		roots: [{ tag: "locality", value, start: 0, end: value.length, confidence: 0.95, children: [] }],
	}
}

/**
 * The three questions the walk asks of a lone bare toponym: the locality lookup, and the two bare-toponym races that
 * check whether the token names a country or a region. A fixture holding only the first starves the walk, which is the
 * superset requirement in miniature — and the recorder meets it by recording under every arm's options.
 */
function lookupsFor(text: string, candidates: SameDataCandidate[]) {
	const queries = [
		{ text, placetype: "locality", limit: 5 },
		{ text, placetype: "country", limit: 1, excludeNameRoles: ["abbr", "gloss"] },
		{ text, placetype: "region", limit: 1, excludeNameRoles: ["abbr", "gloss"] },
	]

	return queries.map((query, index) => ({
		key: canonicalQueryKey(query),
		query,
		candidates: index === 0 ? candidates : [],
	}))
}

function fixtureFor(id: string, candidates: SameDataCandidate[], text = "Springfield"): SameDataFixtureRow {
	const lookups = lookupsFor(text, candidates)

	return {
		id,
		schemaVersion: SAME_DATA_SCHEMA_VERSION,
		tree: tree(text, text),
		lookups,
		pool: candidatePool(lookups),
	}
}

function panelFor(id: string, placeIDs: number[], goldPresent: boolean): SameDataPanelRow {
	return {
		id,
		stratum: goldPresent ? "unambiguous" : "gold_absent",
		query: "Springfield",
		goldPresent,
		gold: {
			geonameid: "4250542",
			placeIDs,
			name: "Springfield",
			country: "US",
			admin1: "IL",
			lat: 39.8017,
			lon: -89.6437,
			population: 114_394,
		},
		source: { register: "geonames:cities15000", license: "CC-BY-4.0", attribution: "GeoNames" },
	}
}

describe("same-data synthetic smoke (#2261)", () => {
	it("grades a selection correct when it names any member of the gold identity set", async () => {
		const panel = panelFor("smoke-correct", [999, 101], true)
		const result = await runResolverArm("mailwoman", panel, fixtureFor("smoke-correct", [SPRINGFIELD_IL]), {})

		expect(result.selection).toBe("101")
		expect(result.correct).toBe(true)
		expect(result.error).toBeUndefined()
	})

	it("reports a wrong-area selection with its distance rather than only a verdict", async () => {
		const panel = panelFor("smoke-area", [101], true)
		const result = await runResolverArm("mailwoman", panel, fixtureFor("smoke-area", [SPRINGFIELD_MA]), {})

		expect(result.correct).toBe(false)
		expect(result.wrongArea).toBe(true)
		expect(result.distanceKm).toBeGreaterThan(25)
	})

	it("records a replay miss as an ERROR, never as an abstention", async () => {
		const panel = panelFor("smoke-miss", [101], true)
		// Everything the walk asks EXCEPT the locality lookup, so exactly one question goes unanswered.
		const starved = fixtureFor("smoke-miss", [SPRINGFIELD_IL])

		starved.lookups = starved.lookups.filter((lookup) => lookup.query.placetype !== "locality")
		starved.pool = candidatePool(starved.lookups)

		const result = await runResolverArm("mailwoman", panel, starved, {})

		expect(result.error).toMatch(/replay miss/)
		expect(result.selection).toBeNull()

		// And the scorer must not count that row as an abstention.
		const metrics = armMetrics("mailwoman", "unambiguous", new Map([[panel.id, panel]]), [result])

		expect(metrics.errors).toBe(1)
		expect(metrics.n).toBe(0)
		expect(metrics.abstentions).toBe(0)
	})

	it("counts a true abstention when the withheld-gold fixture offers nothing", async () => {
		const panel = panelFor("smoke-absent", [101], false)
		const result = await runResolverArm("mailwoman", panel, fixtureFor("smoke-absent", []), {})

		expect(result.error).toBeUndefined()
		expect(result.selection).toBeNull()

		const metrics = armMetrics("mailwoman", "gold_absent", new Map([[panel.id, panel]]), [result])

		expect(metrics.abstentionPrecision).toBe(1)
		expect(metrics.falseSelectionRate).toBe(0)
	})

	it("catches two arms that read different evidence for one row", async () => {
		const panel = panelFor("smoke-unequal", [101], true)
		const rich = fixtureFor("smoke-unequal", [SPRINGFIELD_IL, SPRINGFIELD_MA])
		const poor = fixtureFor("smoke-unequal", [SPRINGFIELD_IL])

		const first = await runResolverArm("mailwoman", panel, rich, {})
		const second = runBaselineArm(panel, poor)

		const problems = assertEqualEvidence([first.evidence, second.evidence])

		expect(problems.length).toBeGreaterThan(0)
		expect(problems.map((problem) => problem.problem).join(" ")).toContain("different candidate ids")
	})

	it("reads equal evidence when both arms are handed the same row", async () => {
		const panel = panelFor("smoke-equal", [101], true)
		const evidence = fixtureFor("smoke-equal", [SPRINGFIELD_IL, SPRINGFIELD_MA])

		const first = await runResolverArm("mailwoman", panel, evidence, {})
		const second = runBaselineArm(panel, evidence)

		expect(assertEqualEvidence([first.evidence, second.evidence])).toEqual([])
	})

	it("carries a machine-readable mechanism on a resolver selection", async () => {
		const panel = panelFor("smoke-mechanism", [101], true)
		const result = await runResolverArm("mailwoman", panel, fixtureFor("smoke-mechanism", [SPRINGFIELD_IL]), {})

		expect(result.mechanism).toMatch(/^picked:/)
	})
})
