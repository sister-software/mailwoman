/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	bucketOf,
	reconcileCoverage,
	reconciliationGeoJSON,
	reconciliationReport,
	type ReconcileConfig,
} from "./reconcile.ts"
import type { ResolvedEntity, SourceRecord } from "./types.ts"

const CONFIG: ReconcileConfig = {
	eligibilitySources: ["nppes", "txhhsc"],
	fundingSources: ["fcc"],
}

function rec(id: string, source: string): SourceRecord {
	return { id, source }
}

function entity(id: string, sources: string[], coordinate?: { latitude: number; longitude: number }): ResolvedEntity {
	const records = sources.map((s, i) => rec(`${s}:${i}`, s))

	return {
		id,
		records,
		representative: { ...records[0]!, organization: { canonical: `Org ${id}`, raw: `Org ${id}` } },
		...(coordinate ? { coordinate } : {}),
		cohesion: sources.length > 1 ? 10 : null,
	}
}

describe("bucketOf", () => {
	it("classifies by the kinds of source present", () => {
		expect(bucketOf(["nppes", "fcc"], CONFIG)).toBe("enrolled")
		expect(bucketOf(["nppes"], CONFIG)).toBe("eligible-not-enrolled")
		expect(bucketOf(["txhhsc"], CONFIG)).toBe("eligible-not-enrolled")
		expect(bucketOf(["fcc"], CONFIG)).toBe("funded-not-eligible")
	})

	it("returns null for an entity with no eligibility- or funding-tagged source (outside the reconciliation)", () => {
		expect(bucketOf(["some-other-source"], CONFIG)).toBeNull()
		expect(bucketOf([], CONFIG)).toBeNull()
	})
})

describe("reconcileCoverage", () => {
	it("buckets every roled entity and counts them; excludes unroled entities", () => {
		const result = reconcileCoverage(
			[
				entity("a", ["nppes", "fcc"]), // enrolled
				entity("b", ["nppes"]), // eligible, not enrolled
				entity("c", ["txhhsc"]), // eligible, not enrolled
				entity("d", ["fcc"]), // funded, not eligible
				entity("e", ["mystery"]), // excluded — no role
			],
			CONFIG
		)
		expect(result.counts).toEqual({ enrolled: 1, "eligible-not-enrolled": 2, "funded-not-eligible": 1 })
		expect(result.reconciled).toHaveLength(4) // 'e' excluded
		expect(result.reconciled.find((r) => r.entity.id === "a")!.bucket).toBe("enrolled")
	})

	it("sorts + dedupes the sources it reports per entity", () => {
		const e: ResolvedEntity = {
			id: "x",
			records: [rec("1", "fcc"), rec("2", "nppes"), rec("3", "nppes")],
			representative: rec("1", "fcc"),
			cohesion: 5,
		}
		const { reconciled } = reconcileCoverage([e], CONFIG)
		expect(reconciled[0]!.sources).toEqual(["fcc", "nppes"])
		expect(reconciled[0]!.bucket).toBe("enrolled")
	})
})

describe("reconciliationGeoJSON", () => {
	it("emits one bucket-tagged Point per located entity, skipping coordinate-less ones", () => {
		const result = reconcileCoverage(
			[entity("a", ["nppes", "fcc"], { latitude: 30.27, longitude: -97.74 }), entity("b", ["nppes"])],
			CONFIG
		)
		const gj = reconciliationGeoJSON(result)
		expect(gj.features).toHaveLength(1) // 'b' has no coordinate
		const f = gj.features[0]!
		expect(f.properties["bucket"]).toBe("enrolled")
		expect(f.properties["sources"]).toEqual(["fcc", "nppes"])
		expect(f.geometry.coordinates).toEqual([-97.74, 30.27])
	})
})

describe("reconciliationReport", () => {
	const result = reconcileCoverage(
		[
			entity("a", ["nppes", "fcc"], { latitude: 30.27, longitude: -97.74 }),
			entity("b", ["nppes"], { latitude: 30.28, longitude: -97.75 }),
		],
		CONFIG
	)

	it("renders the bucket table + enrolled-rate over the eligibility set", () => {
		const md = reconciliationReport(result)
		expect(md).toContain("| bucket | entities | meaning |")
		expect(md).toContain("**enrolled** | 1")
		expect(md).toContain("**eligible, not enrolled** | 1")
		// 1 of 2 eligibility entities are enrolled → 50.0%.
		expect(md).toContain("50.0%")
	})

	it("ALWAYS includes the neutral caveat — never an allegation", () => {
		const md = reconciliationReport(result)
		expect(md).toContain("set-membership reconciliation, not a determination")
		expect(md).toContain("Nothing here is an allegation")
		expect(md).toContain("entirely the data consumer's call")
	})

	it("spot-checks the anti-join set and honors a custom limit + scope/scorer notes", () => {
		const md = reconciliationReport(result, {
			title: "TX coverage",
			scopeNote: "TX-scoped, ≤2000 rows/source.",
			scorerNote: "Scored with the Fellegi-Sunter baseline.",
			spotCheckLimit: 5,
		})
		expect(md).toContain("# TX coverage")
		expect(md).toContain("_TX-scoped, ≤2000 rows/source._")
		expect(md).toContain("Scored with the Fellegi-Sunter baseline.")
		expect(md).toContain('first 5 "eligible, not enrolled"')
		expect(md).toContain("Org b") // the anti-join member shows in the spot-check
	})
})
