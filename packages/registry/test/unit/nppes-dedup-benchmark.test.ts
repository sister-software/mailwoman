/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Unit coverage for the NPPES dedup benchmark's pure stages — org-name tokens, the truth grains, the pairwise
 *   scorer, the lever progression, the adjudication packet, and the report renderer.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { jaccard, type TermFrequencyTable } from "@mailwoman/match"
import { join } from "@mailwoman/platform/path"
import type { ResolvedEntity, SourceRecord } from "@mailwoman/registry/types"
import { describe, expect, it } from "vitest"

import { buildLevers } from "#tools/nppes/levers"
import { ORG_TAU, orgTokens, type NPIPrimary } from "#tools/nppes/org-name"
import { writeOvermergePacket } from "#tools/nppes/overmerge-packet"
import { renderNPPESDedupReport, type NPPESReportInput, type SweepArm } from "#tools/nppes/report"
import type { MessyRow } from "#tools/nppes/sample"
import { choose2, scoreEntities, type Score } from "#tools/nppes/scoring"
import {
	buildOrgNameCoordGrain,
	buildOrgNameGrain,
	buildOrgNameH3Grain,
	collectPrimaryCoordinates,
} from "#tools/nppes/truth-grains"

function record(id: string, latitude?: number, longitude?: number): SourceRecord {
	return {
		id,
		address:
			latitude === undefined || longitude === undefined
				? { components: {}, canonicalKey: `k-${id}` }
				: {
						components: {},
						canonicalKey: `k-${id}`,
						geocode: { coordinate: { latitude, longitude }, tier: "address_point", uncertaintyMeters: 1 },
					},
	}
}

function entity(id: string, records: SourceRecord[]): ResolvedEntity {
	return { id, records, representative: records[0]!, cohesion: null }
}

function primary(entries: Array<[npi: string, org: string, addrKey: string]>): Map<string, NPIPrimary> {
	return new Map(entries.map(([npi, org, addrKey]) => [npi, { tokens: orgTokens(org), addrKey }]))
}

describe("orgTokens", () => {
	it("strips corporate form, articles and punctuation but keeps domain words", () => {
		expect([...orgTokens("The Baylor Clinic, LLC")]).toEqual(["baylor", "clinic"])
		expect([...orgTokens("BAYLOR CLINIC INC.")]).toEqual(["baylor", "clinic"])
	})

	it("scores two spellings of one organization at or above the gold-set threshold", () => {
		expect(jaccard(orgTokens("The Baylor Clinic, LLC"), orgTokens("BAYLOR CLINIC INC."))).toBeGreaterThanOrEqual(
			ORG_TAU
		)

		expect(jaccard(orgTokens("Baylor Clinic"), orgTokens("Memorial Hermann Hospital"))).toBeLessThan(ORG_TAU)
	})

	it("keeps digits, which distinguish numbered sites", () => {
		expect([...orgTokens("Clinic 7")]).toEqual(["clinic", "7"])
	})

	it("yields an empty set for a name that is nothing but stop words", () => {
		expect(orgTokens("The Co of and").size).toBe(0)
	})
})

describe("scoreEntities", () => {
	const npiLabel = (rec: SourceRecord) => rec.id.split("-")[0]!

	it("counts pairs, not clusters", () => {
		expect(choose2(1)).toBe(0)
		expect(choose2(2)).toBe(1)
		expect(choose2(4)).toBe(6)
	})

	it("scores a perfect recovery at 1 across the board", () => {
		const entities = [entity("e1", [record("a-1"), record("a-2")]), entity("e2", [record("b-1"), record("b-2")])]

		const s = scoreEntities(entities, npiLabel, 4)

		expect(s.precision).toBe(1)
		expect(s.recall).toBe(1)
		expect(s.f1).toBe(1)
		expect(s.ari).toBe(1)
		expect(s.clusters).toBe(2)
		expect(s.singletons).toBe(0)
		expect(s.overMergedClusters).toBe(0)
		expect(s.splitNpis).toBe(0)
	})

	it("charges an over-merge to precision and reports its shape", () => {
		const entities = [entity("e1", [record("a-1"), record("a-2"), record("b-1"), record("b-2")])]
		const s = scoreEntities(entities, npiLabel, 4)

		// 2 true pairs recovered out of 6 predicted; both true pairs found.
		expect(s.precision).toBeCloseTo(2 / 6, 12)
		expect(s.recall).toBe(1)
		expect(s.f1).toBeCloseTo(0.5, 12)
		expect(s.overMergedClusters).toBe(1)
		expect(s.recordsInOverMerged).toBe(4)
		expect(s.maxNpisFused).toBe(2)
		expect(s.splitNpis).toBe(0)
	})

	it("charges an under-merge to recall and counts the split label", () => {
		const entities = [entity("e1", [record("a-1")]), entity("e2", [record("a-2")])]
		const s = scoreEntities(entities, npiLabel, 2)

		expect(s.precision).toBe(0)
		expect(s.recall).toBe(0)
		expect(s.f1).toBe(0)
		expect(s.singletons).toBe(2)
		expect(s.splitNpis).toBe(1)
	})

	it("reads the labelled population from totalRecords, so a wrong count moves ARI", () => {
		const entities = [entity("e1", [record("a-1"), record("a-2"), record("b-1")])]

		expect(scoreEntities(entities, npiLabel, 3).ari).not.toBe(scoreEntities(entities, npiLabel, 30).ari)
	})
})

describe("truth grains", () => {
	const npiPrimary = primary([
		["1", "Baylor Clinic LLC", "100 main st"],
		["2", "BAYLOR CLINIC INC", "100 main st"],
		["3", "Memorial Hermann Hospital", "100 main st"],
		["4", "Baylor Clinic", "999 far rd"],
	])

	it("collects an NPI's FIRST geocoded coordinate", () => {
		const coords = collectPrimaryCoordinates([record("1", 29.7, -95.4), record("1", 31, -97), record("2")])

		expect(coords.get("1")).toEqual({ latitude: 29.7, longitude: -95.4 })
		expect(coords.has("2")).toBe(false)
	})

	it("unions same-address same-org NPIs, leaves a distinct co-located org alone", () => {
		const label = buildOrgNameGrain(npiPrimary)

		expect(label(record("1"))).toBe(label(record("2")))
		expect(label(record("3"))).not.toBe(label(record("1")))
		// Same org name, different address key — the string grain cannot see the two are one org.
		expect(label(record("4"))).not.toBe(label(record("1")))
	})

	it("falls back to the record id for an NPI outside the sample", () => {
		expect(buildOrgNameGrain(npiPrimary)(record("999"))).toBe("999")
	})

	it("unions same-org NPIs within the co-location radius and no further", () => {
		const coords = new Map([
			["1", { latitude: 29.7, longitude: -95.4 }],
			// ~20 m north of NPI 1.
			["2", { latitude: 29.70018, longitude: -95.4 }],
			["3", { latitude: 29.7, longitude: -95.4 }],
			// ~11 km away, same org name as NPI 1.
			["4", { latitude: 29.8, longitude: -95.4 }],
		])

		const label = buildOrgNameCoordGrain(npiPrimary, coords)

		expect(label(record("1"))).toBe(label(record("2")))
		expect(label(record("3"))).not.toBe(label(record("1")))
		expect(label(record("4"))).not.toBe(label(record("1")))
	})

	it("leaves an un-geocoded NPI a singleton under the coordinate grain", () => {
		const label = buildOrgNameCoordGrain(npiPrimary, new Map([["1", { latitude: 29.7, longitude: -95.4 }]]))

		expect(label(record("2"))).not.toBe(label(record("1")))
	})

	it("reproduces the coordinate grain when same-org NPIs share an H3 cell", () => {
		const coords = new Map([
			["1", { latitude: 29.7, longitude: -95.4 }],
			["2", { latitude: 29.7, longitude: -95.4 }],
			["3", { latitude: 29.7, longitude: -95.4 }],
		])

		const label = buildOrgNameH3Grain(npiPrimary, coords, 11)

		expect(label(record("1"))).toBe(label(record("2")))
		expect(label(record("3"))).not.toBe(label(record("1")))
		// Un-geocoded: seeded, so it is its own class rather than absent.
		expect(label(record("4"))).toBe("4")
	})
})

describe("buildLevers", () => {
	const table: TermFrequencyTable = { total: 10, distinct: 5, frequency: () => 0.1 }
	const levers = buildLevers(table)

	it("opens on the bare baseline with both proven levers pinned off", () => {
		expect(levers[0]!.config).toEqual({ collapseSpatial: false, addressFrequency: false })
	})

	it("sets collapseSpatial and addressFrequency EXPLICITLY on every row", () => {
		for (const lever of levers) {
			expect(Object.hasOwn(lever.config, "collapseSpatial")).toBe(true)
			expect(Object.hasOwn(lever.config, "addressFrequency")).toBe(true)
		}
	})

	it("ends on the taxonomy code-set discriminator, stacked on A1 + authorized-official", () => {
		expect(levers.at(-1)!.config).toEqual({
			collapseSpatial: true,
			addressFrequency: table,
			discriminators: ["authorizedOfficial"],
			exactDiscriminators: ["taxonomy"],
		})
	})
})

describe("writeOvermergePacket", () => {
	const rows: MessyRow[] = [
		{
			npi: "1",
			name: "Baylor",
			org: "Baylor",
			address: "100 main",
			auth: "Ada Lovelace",
			taxonomy: "207Q",
			entityID: "e",
		},
		{
			npi: "3",
			name: "Hermann",
			org: "Hermann",
			address: "100 main",
			auth: "Grace Hopper",
			taxonomy: "208D",
			entityID: "e",
		},
	]

	it("writes only the multi-label clusters and returns their count", async () => {
		await using dirDirectory = await temporaryDirectory("nppes-packet-")
		const dir = dirDirectory.path
		const path = join(dir, "packet.md")

		try {
			const clusters = await writeOvermergePacket(path, {
				entities: [entity("e1", [record("1"), record("3")]), entity("e2", [record("1"), record("1")])],
				rows,
				recordCount: 4,
				maxNpis: 300,
				state: "CA",
				orgNameLabel: (rec) => rec.id,
			})

			const text = await readLocalTextFile(path)

			expect(clusters).toBe(1)
			expect(text).toContain("## Cluster 1 —")
			expect(text).not.toContain("## Cluster 2")
			expect(text).toContain('auth="Ada Lovelace"')
			expect(text).toContain('taxonomy="208D"')
			// The header names the run an adjudicator is holding. It read `TX` for every state until the
			// sample's own state was threaded through, so a CA packet claimed to be a TX one.
			expect(text).toContain("CA --max-npis 300")
			expect(text).not.toContain("TX")
		} finally {
		}
	})
})

describe("renderNPPESDedupReport", () => {
	const score = (over: Partial<Score> = {}): Score => ({
		precision: 0.5,
		recall: 0.5,
		f1: 0.5,
		ari: 0.5,
		clusters: 2,
		singletons: 0,
		overMergedClusters: 0,
		recordsInOverMerged: 0,
		maxNpisFused: 0,
		splitNpis: 0,
		...over,
	})

	const arm = (t: number, f1: number): SweepArm => ({
		t,
		res: { candidatePairs: 42, droppedBlocks: [] },
		score: score({ f1 }),
	})

	function input(over: Partial<NPPESReportInput> = {}): NPPESReportInput {
		const sweep = [arm(0, 0.5), arm(4, 0.7), arm(8, 0.6)]

		return {
			state: "TX",
			keptNpis: 100,
			recordCount: 250,
			geocoded: 245,
			trainEM: true,
			addressFrequency: { total: 1_234_567, distinct: 7654, frequency: () => 0 },
			progression: [
				{ label: "baseline", score: score({ f1: 0.4 }) },
				{ label: "+ inverse-address-frequency", score: score({ f1: 0.45 }) },
				{ label: "+ collapsed spatial signal", score: score({ f1: 0.5 }) },
				{ label: "+ authorized-official discriminator", score: score({ f1: 0.55 }) },
			],
			defaultOutOfBox: score({ f1: 0.41 }),
			sweep,
			best: sweep[1]!,
			entityCount: 90,
			orgCount: 70,
			orgCoordCount: 65,
			orgH3Count: 66,
			fsNPI: score({ f1: 0.55 }),
			fsEntity: score({ f1: 0.6 }),
			fsOrg: score({ f1: 0.7 }),
			fsOrgCoord: score({ f1: 0.72 }),
			gbtNPI: score({ f1: 0.6 }),
			gbtEntity: score({ f1: 0.65 }),
			gbtOrg: score({ f1: 0.75 }),
			gbtOrgCoord: score({ f1: 0.78 }),
			gbtOrgH3: score({ f1: 0.775 }),
			candidate: null,
			h3Res: 11,
			geocodedNpis: 95,
			...over,
		}
	}

	it("renders one progression row per lever and bolds the last", () => {
		const md = renderNPPESDedupReport(input())

		expect(md).toContain("| baseline | 50.0% | 50.0% | 40.0% | — |")
		expect(md).toContain("| **+ authorized-official discriminator** |")
		expect(md).toContain("| + inverse-address-frequency | 50.0% | 50.0% | 45.0% | +5.0pp |")
	})

	it("stars exactly the best sweep arm", () => {
		const md = renderNPPESDedupReport(input())
		const starred = md.match(/^.*⭐.*$/gmu) ?? []

		expect(starred).toHaveLength(1)
		expect(starred[0]).toContain("| 4 |")
	})

	it("reads the default-threshold prose off the best arm", () => {
		const sweep = [arm(0, 0.7), arm(4, 0.5)]
		const md = renderNPPESDedupReport(input({ sweep, best: sweep[0]! }))

		expect(md).toContain("Best F1 is at the **default threshold** (70.0%)")
	})

	it("formats the corpus-wide table sizes with separators", () => {
		expect(renderNPPESDedupReport(input())).toContain("(7,654 distinct addresses over 1,234,567 providers)")
	})

	it("calls the H3 grain robust when it lands within the parity tolerance", () => {
		expect(renderNPPESDedupReport(input())).toContain("Within noise of the haversine grain")
	})

	it("reports the gap when the H3 grain lands outside the parity tolerance", () => {
		const md = renderNPPESDedupReport(input({ gbtOrgH3: score({ f1: 0.9 }) }))

		expect(md).toContain("The two co-location methods differ by +12.0pp")
	})

	it("adds the candidate rows only when a candidate was scored", () => {
		expect(renderNPPESDedupReport(input())).not.toContain("GBT candidate")

		const md = renderNPPESDedupReport(
			input({ candidate: { label: "GBT candidate (9-feat)", npi: score({ f1: 0.6 }), entity: score({ f1: 0.7 }) } })
		)

		expect(md).toContain("| GBT candidate (9-feat) | NPI |")
		expect(md).toContain("| GBT candidate (9-feat) | **entity** |")
	})
})
