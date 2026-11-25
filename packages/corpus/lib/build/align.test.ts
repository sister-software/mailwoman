// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { parseJSONStrict } from "@mailwoman/core/values/json"
import { createLicenseVerdictCache, LicensePolicy } from "@mailwoman/license/policy"
import { describe, expect, it } from "vitest"

import { createUnitSplitter } from "#adapters/street/unit"
import { createRowAligner, emptyAlignResult, type AlignTally } from "#build/align"
import { alignTotalsOf, mergeAlignTotals, serializeAlignTotals } from "#build/align/totals"
import { componentFindingsRecord, ComponentRule } from "#build/component-check"
import { createIneligibilityReader } from "#build/eligibility"
import type { RegionNames } from "#build/region/names"
import { recountRegionCheck, type RegionCheckedRecord } from "#build/region/recount"
import type { CanonicalRow } from "#types"

const units = await createUnitSplitter()

/**
 * The regions the rows below name, standing in for the WOF admin database.
 */
const US_REGIONS: RegionNames = {
	path: "fixture",
	holds: (country, region) => (country === "US" ? ["TX", "FL"].includes(region) : null),
}

const row = (source: string, sourceID: string, components: CanonicalRow["components"]): CanonicalRow => ({
	raw: Object.values(components).join(", "),
	components,
	country: "US",
	source,
	source_id: sourceID,
	license: "CC0-1.0",
})

/**
 * Aligns `rows` through one aligner and returns its totals and the reasons it quarantined.
 */
function alignAll(rows: readonly CanonicalRow[], regions: RegionNames | null = US_REGIONS) {
	const ineligibility = createIneligibilityReader(null)
	const licenses = createLicenseVerdictCache(LicensePolicy.All)
	const result = emptyAlignResult(licenses, ineligibility.refused)
	const reasons: string[] = []

	const tally: AlignTally = {
		aligned: 0,
		quarantined: 0,
		excludedByLicense: 0,
		admittedUnresolved: 0,
		excludedByEligibility: 0,
	}

	const alignOne = createRowAligner({
		synthesize: false,
		holdouts: {},
		licenses,
		ineligibility,
		units,
		regions,
		result,
		tally,
		sinks: {
			labeled: () => {},
			quarantine: (line) => reasons.push(parseJSONStrict<{ reason: string }>(line).reason),
		},
	})

	for (const r of rows) {
		alignOne(r)
	}

	return { totals: alignTotalsOf({ ...result, ...tally }), reasons }
}

describe("createRowAligner's component check", () => {
	it("counts every rule a row fails per source, and quarantines a row only for an enforced rule", () => {
		const { totals, reasons } = alignAll([
			// `street:trailing-unit` is reported only, so the row is aligned.
			row("state-tx-notaries", "a", {
				house_number: "4744",
				street: "N Mesa Apt 266",
				locality: "El Paso",
				region: "TX",
			}),
			// `locality:holds-street` is enforced.
			row("gleif-lei", "b", {
				house_number: "56",
				street: "East Chase Street",
				locality: "56 East Chase Street",
				region: "FL",
			}),
			row("gleif-lei", "c", { house_number: "1", street: "Main St", locality: "Pensacola", region: "FL" }),
		])

		expect(componentFindingsRecord(totals.componentFindingsBySource)).toEqual({
			"state-tx-notaries": { [ComponentRule.StreetTrailingUnit]: 1 },
			"gleif-lei": { [ComponentRule.LocalityHoldsStreet]: 1 },
		})

		expect(reasons).toEqual([`component-invalid:${ComponentRule.LocalityHoldsStreet}`])
		expect(totals.quarantined).toBe(1)
	})

	it("merges the per-source counts of separate ranges into the counts of one serial pass", () => {
		const rows = [
			row("state-tx-notaries", "a", {
				house_number: "4744",
				street: "N Mesa Apt 266",
				locality: "El Paso",
				region: "TX",
			}),
			row("state-tx-notaries", "b", {
				house_number: "2022",
				street: "Branard Apt 6",
				locality: "Houston",
				region: "TX",
			}),
			row("state-tx-notaries", "c", { house_number: "1", street: "Grand Valley Dr", locality: "TX", region: "TX" }),
		]

		const serial = alignAll(rows).totals

		const merged = mergeAlignTotals([
			serializeAlignTotals(alignAll(rows.slice(0, 1)).totals),
			serializeAlignTotals(alignAll(rows.slice(1)).totals),
		])

		expect(componentFindingsRecord(merged.componentFindingsBySource)).toEqual(
			componentFindingsRecord(serial.componentFindingsBySource)
		)

		expect(componentFindingsRecord(serial.componentFindingsBySource)).toEqual({
			"state-tx-notaries": { [ComponentRule.StreetTrailingUnit]: 2, [ComponentRule.LocalityRepeatsRegion]: 1 },
		})
	})

	it("reports a region its country doesn't hold, and records the rule as unchecked without the database", () => {
		const rows = [
			row("usgov-nad", "a", { house_number: "1811", street: "Hayes Avenue", locality: "Hull", region: "IA IA" }),
		]

		const checked = alignAll(rows)

		expect(componentFindingsRecord(checked.totals.componentFindingsBySource)).toEqual({
			"usgov-nad": { [ComponentRule.RegionUnknown]: 1 },
		})

		expect(checked.reasons).toEqual([])
		expect([...checked.totals.uncheckedComponentRules]).toEqual([])

		const unchecked = alignAll(rows, null)

		expect(componentFindingsRecord(unchecked.totals.componentFindingsBySource)).toEqual({})

		// One range without the database leaves the whole build's count short, so the merge keeps the rule unchecked.
		const merged = mergeAlignTotals([serializeAlignTotals(checked.totals), serializeAlignTotals(unchecked.totals)])

		expect([...merged.uncheckedComponentRules]).toEqual([ComponentRule.RegionUnknown])
	})
})

describe("recountRegionCheck", () => {
	const rows = [
		row("usgov-nad", "a", { house_number: "1", street: "Main St", locality: "Pensacola", region: "FL" }),
		row("usgov-nad", "b", { house_number: "2", street: "Main St", locality: "Pensacola", region: "FL" }),
		row("usgov-nad", "c", { house_number: "4744", street: "N Mesa Apt 266", locality: "El Paso", region: "TX" }),
		row("usgov-nad", "d", { house_number: "1811", street: "Hayes Avenue", locality: "Hull", region: "IA IA" }),
	]

	// A rebuilt admin database that no longer holds Florida.
	const WITHOUT_FLORIDA: RegionNames = {
		path: "rebuilt",
		holds: (country, region) => (country === "US" ? region === "TX" : null),
	}

	const recordOf = (
		totals: ReturnType<typeof alignAll>["totals"],
		regionCheck: Record<string, string>
	): RegionCheckedRecord => ({
		source: "usgov-nad",
		derivation: { config: {} },
		totals: serializeAlignTotals(totals),
		regionCheck,
	})

	// An align lists rules in the order it first saw a failing row.
	// A recount can't know that order.
	// The tests therefore compare counts per rule.
	const countsOf = (findings: [string, [ComponentRule, number][]][] | undefined) =>
		Object.fromEntries((findings ?? []).map(([source, rules]) => [source, Object.fromEntries(rules)]))

	it("recounts region:unknown to the count an align under the new region data writes", async () => {
		const before = recordOf(alignAll(rows).totals, { regionDatabase: "old" })
		const recounted = await recountRegionCheck(before, { regionDatabase: "new" }, async () => WITHOUT_FLORIDA)
		const fresh = serializeAlignTotals(alignAll(rows, WITHOUT_FLORIDA).totals)

		expect(countsOf(recounted.record?.totals.component_findings_by_source)).toEqual(
			countsOf(fresh.component_findings_by_source)
		)

		expect(countsOf(fresh.component_findings_by_source)["usgov-nad"]?.[ComponentRule.RegionUnknown]).toBe(3)
		expect(recounted.record?.regionCheck).toEqual({ regionDatabase: "new" })
	})

	it("lists the rule as unchecked when the new build reads no region data", async () => {
		const before = recordOf(alignAll(rows).totals, { regionDatabase: "old" })
		const recounted = await recountRegionCheck(before, { regionDatabase: "absent" }, async () => null)
		const fresh = serializeAlignTotals(alignAll(rows, null).totals)

		expect(countsOf(recounted.record?.totals.component_findings_by_source)).toEqual(
			countsOf(fresh.component_findings_by_source)
		)

		expect(recounted.record?.totals.unchecked_component_rules).toEqual([ComponentRule.RegionUnknown])
	})

	it("refuses a record made under other region data that records no region values", async () => {
		const { region_values: _values, ...totals } = serializeAlignTotals(alignAll(rows).totals)

		const before: RegionCheckedRecord = {
			source: "usgov-nad",
			derivation: { config: {} },
			totals,
			regionCheck: { regionDatabase: "old" },
		}

		const recounted = await recountRegionCheck(before, { regionDatabase: "new" }, async () => WITHOUT_FLORIDA)

		expect(recounted.problem).toMatch(/records no region values/u)
	})
})
