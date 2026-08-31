/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The constraint census, tested against a FAKE engine and a FAKE candidate table.
 *
 *   What is under test is the accounting — reachability kept apart from coverage, a gate called inert only when it
 *   never accompanied a pick — not whether the resolver is right about any particular place. A test that loaded the
 *   real gazetteer would take minutes and fail for reasons this file has no opinion about.
 */

import type { EngineRegistryLike } from "@mailwoman/dev-mcp/engine-registry"
import { describe, expect, it } from "vitest"

import { stubEngine, stubEngineRegistry } from "#test/stub-registry"

interface FakeLookup {
	tag: string
	value: string
	placetype: string
	gates: string[]
	picked: boolean
	candidates?: number
}

/**
 * `name_key` → the placetypes holding it, standing in for candidate.db.
 *
 * `nowhereville` is deliberately present with an EMPTY list: a key the table never heard of and a key it holds in no
 * other band must both read as coverage, and only one of those is a missing row.
 */
const HOLDINGS: Record<string, string[]> = {
	"illes balears": ["region", "macroregion"],
	bayern: ["region", "neighbourhood"],
	nowhereville: [],
}

const dependencies = {
	openArtifact: () => ({
		db: {
			prepare: () => ({
				all: (key: unknown) => (HOLDINGS[String(key)] ?? []).map((placetype) => ({ placetype })),
			}),
			destroy: () => {},
		},
	}),
}

function fakeRegistry(byInput: Record<string, FakeLookup[]>): EngineRegistryLike {
	return stubEngineRegistry({
		acquire: async () =>
			stubEngine({
				engineID: "fake",
				effective: { dataRoot: "/fake" },
				fingerprint: { digest: "d", gitHead: "g", dirtyFiles: [] },
				buildMs: 1,
				uses: 1,
				session: {
					geocode: async (input: string) => ({
						result: {},
						trace: {
							resolver: (byInput[input] ?? []).map((l) => ({
								tag: l.tag,
								value: l.value,
								placetype: l.placetype,
								query: { limit: 5 },
								gates: l.gates,
								candidates: Array.from({ length: l.candidates ?? 0 }, () => ({})),
								candidatesTruncated: 0,
								picked: l.picked ? { id: 1, name: l.value, source: "ranked" } : null,
							})),
						},
					}),
				},
			}),
	})
}

const LITERAL = (inputs: string[]) => ({ kind: "literal" as const, inputs, why: "census unit test" })

describe("constraint census", () => {
	it("keeps REACHABILITY apart from COVERAGE and never sums them", async () => {
		const { runConstraintCensus } = await import("@mailwoman/dev-mcp/constraint-census")

		const registry = fakeRegistry({
			a: [{ tag: "locality", value: "Illes Balears", placetype: "locality", gates: [], picked: false }],
			b: [{ tag: "locality", value: "Nowhereville", placetype: "locality", gates: [], picked: false }],
		})

		const r = await runConstraintCensus(registry, { inputs: LITERAL(["a", "b"]) }, dependencies)

		expect(r.n_resolved_nothing).toBe(2)
		expect(r.n_reachability).toBe(1)
		expect(r.n_coverage).toBe(1)
		expect(r.misses.find((m) => m.value === "Illes Balears")?.elsewhere).toEqual(["macroregion", "region"])
		expect(r.misses.find((m) => m.value === "Nowhereville")?.elsewhere).toEqual([])
		expect(r.summary).toContain("never summed")
	})

	it("calls a gate INERT only when it fired enough AND never accompanied a pick", async () => {
		const { runConstraintCensus } = await import("@mailwoman/dev-mcp/constraint-census")
		const dead = Array.from({ length: 25 }, (_, i) => `dead${i}`)
		const byInput: Record<string, FakeLookup[]> = {}

		for (const k of dead) {
			byInput[k] = [{ tag: "locality", value: "Bayern", placetype: "locality", gates: ["some_retry"], picked: false }]
		}

		// A second gate fires just as often but DOES pick sometimes — it must not be called inert.
		byInput["alive"] = [{ tag: "locality", value: "Bayern", placetype: "locality", gates: ["live_gate"], picked: true }]

		const r = await runConstraintCensus(fakeRegistry(byInput), { inputs: LITERAL([...dead, "alive"]) }, dependencies)

		expect(r.inert_gates.join()).toContain("some_retry")
		expect(r.inert_gates.join()).not.toContain("live_gate")
	})

	it("does not call a rarely-fired gate inert, because that claim needs firings", async () => {
		const { runConstraintCensus } = await import("@mailwoman/dev-mcp/constraint-census")

		const r = await runConstraintCensus(
			fakeRegistry({
				a: [{ tag: "locality", value: "Bayern", placetype: "locality", gates: ["rare_gate"], picked: false }],
			}),
			{ inputs: LITERAL(["a"]) },
			dependencies
		)

		expect(r.inert_gates).toEqual([])
		expect(r.summary).toContain("No gate reached the inert threshold")
	})

	it("separates a null pick WITH candidates (rejected downstream) from an empty probe", async () => {
		const { runConstraintCensus } = await import("@mailwoman/dev-mcp/constraint-census")

		const r = await runConstraintCensus(
			fakeRegistry({
				a: [{ tag: "locality", value: "Bayern", placetype: "locality", gates: [], picked: false, candidates: 4 }],
				b: [{ tag: "locality", value: "Bayern", placetype: "locality", gates: [], picked: false }],
			}),
			{ inputs: LITERAL(["a", "b"]) },
			dependencies
		)

		expect(r.misses.filter((m) => m.had_candidates)).toHaveLength(1)
		expect(r.misses.filter((m) => !m.had_candidates)).toHaveLength(1)
	})

	it("counts a lookup that PICKED as neither a miss nor a coverage fact", async () => {
		const { runConstraintCensus } = await import("@mailwoman/dev-mcp/constraint-census")

		const r = await runConstraintCensus(
			fakeRegistry({
				a: [{ tag: "locality", value: "Illes Balears", placetype: "locality", gates: [], picked: true }],
			}),
			{ inputs: LITERAL(["a"]) },
			dependencies
		)

		expect(r.n_lookups).toBe(1)
		expect(r.n_resolved_nothing).toBe(0)
		expect(r.n_reachability).toBe(0)
		expect(r.n_coverage).toBe(0)
	})
})
