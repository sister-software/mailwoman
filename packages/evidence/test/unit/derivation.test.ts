/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The derivation projection names every constraint in order and fabricates nothing.
 */

import {
	CoverageBasis,
	EpistemicStatus,
	observation,
	projectDerivation,
	requireExclusionBasis,
} from "@mailwoman/evidence"
import { describe, expect, it } from "vitest"

describe("projectDerivation", () => {
	it("names every constraint and its contribution in order", () => {
		const p = projectDerivation({
			status: EpistemicStatus.Observed,
			uncertaintyM: 2100,
			nodes: [
				{ label: "locality", evidence: observation("wof", "2026-05", { id: 101_750_367 }), contribution: "resolved" },
				{
					label: "street",
					evidence: requireExclusionBasis({
						layer: "os-open-uprn",
						source: "os-open-uprn",
						vintage: "2026-08",
						h3Cell: 1,
						cell: { basis: CoverageBasis.Designated },
						probeFold: "uprn-point@res9",
						layerFold: "uprn-point@res9",
					})!,
					contribution: "excluded against a designated cell",
				},
			],
		})

		expect(p.status).toBe("observed")
		expect(p.constraints).toHaveLength(2)
		expect(p.constraints[1]!.evidence.kind).toBe("exclusion")
		expect(p.uncertaintyM).toBe(2100)
	})

	it("an unresolved projection carries no uncertainty rather than a fabricated one", () => {
		const p = projectDerivation({ status: EpistemicStatus.Unresolved, nodes: [], uncertaintyM: null })

		expect(p.status).toBe("unresolved")
		expect(p.uncertaintyM).toBeNull()
		expect(p.constraints).toEqual([])
	})

	it("is frozen and holds copies, so a caller's later mutation does not change the report", () => {
		const node = { label: "locality", evidence: observation("wof", null, { id: 1 }), contribution: "resolved" }
		const p = projectDerivation({ status: EpistemicStatus.Observed, nodes: [node], uncertaintyM: null })

		node.contribution = "changed after the fact"

		expect(p.constraints[0]!.contribution).toBe("resolved")
		expect(Object.isFrozen(p)).toBe(true)
		expect(Object.isFrozen(p.constraints)).toBe(true)
	})
})
