/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A trace record becomes one derivation constraint, and a miss is reported as a miss.
 */

import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import { traceToDerivationNode } from "mailwoman/geocode"
import { describe, expect, it } from "vitest"

const base: ResolveNodeTrace = {
	tag: "locality",
	value: "Whitby",
	placetype: "locality",
	query: { limit: 10 },
	checks: ["importance"],
	candidates: [
		{ id: 1, name: "Whitby", country: "CA", placetype: "locality", score: 1, ranks: { initial: 1, importance: 2 } },
		{ id: 2, name: "Whitby", country: "GB", placetype: "locality", score: 1, ranks: { initial: 2, importance: 1 } },
	],
	candidatesTruncated: 0,
	picked: { id: 2, name: "Whitby", source: "ranked" },
}

describe("traceToDerivationNode", () => {
	it("a pick becomes an observation of the gazetteer row, with no vintage invented", () => {
		const node = traceToDerivationNode(base)

		expect(node.label).toBe("locality=Whitby")
		expect(node.evidence.kind).toBe("observation")
		expect(node.evidence).toMatchObject({ source: "gazetteer", vintage: null, value: { id: 2, placetype: "locality" } })
		expect(node.contribution).toBe("picked Whitby (locality) by ranked")
	})

	it("a miss names the candidates that failed the checks, or the register's silence", () => {
		const failed = traceToDerivationNode({ ...base, picked: null })
		const silent = traceToDerivationNode({ ...base, picked: null, candidates: [] })

		expect(failed.contribution).toBe("resolved nothing: 2 candidates, none passed importance")
		expect(silent.contribution).toBe("resolved nothing: the register holds no locality for this value")
		expect(silent.evidence).toMatchObject({ value: { checks: ["importance"] } })
	})
})
