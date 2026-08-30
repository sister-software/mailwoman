/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ladder diff, tested against a FAKE engine.
 *
 *   The registry is stubbed on purpose: what is under test is whether the diff reports gained, lost and changed as
 *   three different facts and finds the first rung that moves — not whether the parser is right about Spain. A test
 *   that loaded a real engine would take minutes, need weights present, and would fail for reasons that have nothing
 *   to do with this file.
 */

import { stubEngine, stubEngineRegistry } from "../stub-registry.ts"
import type { EngineRegistryLike } from "@mailwoman/dev-mcp/engine-registry"
import { runMinimalPairs } from "@mailwoman/dev-mcp/minimal-pairs"
import { describe, expect, it } from "vitest"

interface FakeResult {
	components: Record<string, string>
	lat: number | null
	lon: number | null
	resolution_tier: string
	intent_markers?: Array<{ kind: string }>
}

/**
 * A registry whose engine answers from a table keyed by input. An input the table does not name throws, which is how
 * the errored-rung path is exercised.
 */
function fakeRegistry(answers: Record<string, FakeResult>): EngineRegistryLike {
	return stubEngineRegistry({
		acquire: async () =>
			stubEngine({
				engineID: "fake",
			effective: { locale: "en-US" },
			session: {
				geocode: async (input: string) => {
					const result = answers[input]

					if (!result) throw new Error(`no fake answer for ${input}`)

					return { result }
				},
			},
		}),
	})
}

const PORTOPETRO = "Portopetro, Illes Balears, Spain"
const PORTOPETRO_PC = "07691 Portopetro, Illes Balears, Spain"
const PORTOPETRO_PC_HN = "15, 07691 Portopetro, Illes Balears, Spain"

describe("minimal-pair ladders", () => {
	it("names the rung where a component is LOST, and calls it the first divergence", async () => {
		const registry = fakeRegistry({
			[PORTOPETRO]: {
				components: { locality: "Portopetro", region: "Illes Balears" },
				lat: 39.3,
				lon: 3.2,
				resolution_tier: "locality",
			},
			[PORTOPETRO_PC]: {
				components: { locality: "Portopetro", postcode: "07691" },
				lat: 39.3,
				lon: 3.2,
				resolution_tier: "locality",
			},
		})

		const result = await runMinimalPairs(registry, { ladders: [{ rungs: [PORTOPETRO, PORTOPETRO_PC] }] })
		const ladder = result.ladders[0]!

		expect(ladder.first_divergence?.step).toBe(1)
		expect(ladder.first_divergence?.tags).toContain("-region")
		expect(ladder.first_divergence?.tags).toContain("+postcode")
		expect(ladder.rungs[1]!.delta?.lost).toEqual([{ tag: "region", value: "Illes Balears" }])
	})

	it("reports a CHANGED value distinctly from a gained or lost one", async () => {
		const registry = fakeRegistry({
			a: { components: { locality: "Portopetro" }, lat: 39.3, lon: 3.2, resolution_tier: "locality" },
			b: { components: { locality: "Illes Balears" }, lat: 39.5, lon: 3, resolution_tier: "region" },
		})

		const result = await runMinimalPairs(registry, { ladders: [{ rungs: ["a", "b"] }] })
		const delta = result.ladders[0]!.rungs[1]!.delta!

		expect(delta.changed).toEqual([{ tag: "locality", from: "Portopetro", to: "Illes Balears" }])
		expect(delta.gained).toEqual([])
		expect(delta.lost).toEqual([])
		expect(delta.tier_from).toBe("locality")
		expect(delta.tier_to).toBe("region")
	})

	it("reports a ladder that never moves as a MEASURED negative, not as an absence", async () => {
		const same = { components: { locality: "Springfield" }, lat: 1, lon: 1, resolution_tier: "locality" }
		const registry = fakeRegistry({ a: same, b: same, c: same })

		const result = await runMinimalPairs(registry, { ladders: [{ rungs: ["a", "b", "c"] }] })

		expect(result.ladders[0]!.first_divergence).toBeNull()
		expect(result.ladders[0]!.rendered).toContain("no divergence")
		expect(result.summary).toContain("0 of 1 ladder(s) diverged")
		expect(result.n_rungs_evaluated).toBe(3)
	})

	it("keeps a NULL coordinate out of the distance, because abstention is not distance zero", async () => {
		const registry = fakeRegistry({
			a: { components: { locality: "X" }, lat: 1, lon: 1, resolution_tier: "locality" },
			b: { components: { locality: "X" }, lat: null, lon: null, resolution_tier: "none" },
		})

		const result = await runMinimalPairs(registry, { ladders: [{ rungs: ["a", "b"] }] })

		expect(result.ladders[0]!.rungs[1]!.delta?.moved_km).toBeNull()
		// The components are identical, so the ONLY thing that diverged is the abstention flip. It must still be caught.
		expect(result.ladders[0]!.first_divergence?.step).toBe(1)
	})

	it("counts an errored rung and keeps measuring the rest of the ladder", async () => {
		const registry = fakeRegistry({
			a: { components: { locality: "X" }, lat: 1, lon: 1, resolution_tier: "locality" },
			c: { components: { locality: "Y" }, lat: 2, lon: 2, resolution_tier: "locality" },
		})

		const result = await runMinimalPairs(registry, { ladders: [{ rungs: ["a", "b", "c"] }] })

		expect(result.n_rungs_requested).toBe(3)
		expect(result.n_rungs_evaluated).toBe(2)
		expect(result.n_rungs_errored).toBe(1)
		expect(result.ladders[0]!.rungs[1]!.error).toContain("no fake answer")
	})

	it("renders every input beside its own result", async () => {
		const registry = fakeRegistry({
			[PORTOPETRO]: {
				components: { locality: "Portopetro", region: "Illes Balears" },
				lat: 39.3,
				lon: 3.2,
				resolution_tier: "locality",
			},
			[PORTOPETRO_PC]: {
				components: { locality: "Portopetro", postcode: "07691" },
				lat: 39.3,
				lon: 3.2,
				resolution_tier: "locality",
			},
			[PORTOPETRO_PC_HN]: {
				components: { locality: "Illes Balears", postcode: "07691", house_number: "15" },
				lat: 39.5,
				lon: 3,
				resolution_tier: "region",
			},
		})

		const result = await runMinimalPairs(registry, {
			ladders: [{ label: "es-portopetro", rungs: [PORTOPETRO, PORTOPETRO_PC, PORTOPETRO_PC_HN] }],
		})

		const rendered = result.ladders[0]!.rendered

		for (const input of [PORTOPETRO, PORTOPETRO_PC, PORTOPETRO_PC_HN]) {
			expect(rendered).toContain(input)
		}

		expect(rendered).toContain("diverges at")
	})

	it("names a #1649 REFUSAL on the rung, so it does not read as a parse that found nothing", async () => {
		const registry = fakeRegistry({
			"St Mary's, Oxford": { components: { locality: "Oxford" }, lat: 51.7, lon: -1.2, resolution_tier: "admin" },
			"Cafe at St Mary's, Oxford": {
				components: {},
				lat: null,
				lon: null,
				resolution_tier: "admin",
				intent_markers: [{ kind: "poi_category" }],
			},
		})

		const result = await runMinimalPairs(registry, {
			ladders: [{ rungs: ["St Mary's, Oxford", "Cafe at St Mary's, Oxford"] }],
		})

		expect(result.ladders[0]!.rungs[1]!.refused).toBe("poi_category")
		expect(result.ladders[0]!.rendered).toContain("REFUSED as poi_category")
		expect(result.ladders[0]!.rendered).toContain("parse discarded, not failed")
	})

	it("refuses an empty ladder list rather than reporting zero of zero", async () => {
		await expect(runMinimalPairs(fakeRegistry({}), { ladders: [] })).rejects.toThrow("no ladders supplied")
	})
})
