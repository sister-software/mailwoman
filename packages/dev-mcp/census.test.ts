/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { NeuralParseTrace } from "@mailwoman/neural"
import { describe, expect, it } from "vitest"

import { aggregateCensus, CENSUS_ALLOWLIST } from "./census.ts"
import { evidenceCensus, priorSignals } from "./evidence.ts"

/**
 * A minimal parse trace. Two tokens, two labels — enough to make every tally reachable by hand.
 */
function trace(overrides: Partial<NeuralParseTrace> = {}): NeuralParseTrace {
	return {
		text: "x y",
		caseNormalized: false,
		pieces: [
			{ piece: "x", id: 1, start: 0, end: 1 },
			{ piece: "y", id: 2, start: 2, end: 3 },
		],
		logits: [
			[1, 0],
			[0, 1],
		],
		emissions: [
			[1, 0],
			[0, 1],
		],
		detectedSystem: null,
		systemSource: "off",
		priors: [],
		labels: ["O", "B-locality"],
		path: [0, 1],
		decode: "viterbi",
		repairs: [],
		tokens: [],
		...overrides,
	}
}

const FIRED = { features: [[0.4], [0]], confidence: [0.4, 0] }

const SILENT = {
	features: [
		[0, 0],
		[0, 0],
	],
	confidence: [0, 0],
}

describe("evidenceCensus", () => {
	it("keeps absent, silent and fired apart — they have different remedies", () => {
		const reading = evidenceCensus(trace({ gazetteer: SILENT, country: FIRED }))

		expect(reading.anchor).toEqual({ state: "absent" })
		expect(reading.gazetteer).toEqual({ state: "silent", of: 2 })
		expect(reading.country).toEqual({ state: "fired", tokens_fired: 1, of: 2 })
		expect(reading.silent).toBe(false)
	})

	it("flags starvation only when every PRESENT channel is silent", () => {
		// The Weimar signature: channels configured, retrieval fed nothing, model decided from embeddings alone.
		expect(evidenceCensus(trace({ anchor: SILENT, gazetteer: SILENT, country: SILENT })).silent).toBe(true)
	})

	it("does not call an unconfigured session starved", () => {
		// No channels at all is a fact about the configuration, not about this input. Reporting it as starvation would
		// send the reader to the retrieval side when the wiring is what is missing.
		expect(evidenceCensus(trace()).silent).toBe(false)
	})

	it("counts firing over features, not confidence", () => {
		// Features are what the model reads; confidence is derived beside them. If they disagree, the features win.
		const disagreeing = { features: [[0.5], [0]], confidence: [0, 0] }

		expect(evidenceCensus(trace({ gazetteer: disagreeing })).gazetteer).toEqual({
			state: "fired",
			tokens_fired: 1,
			of: 2,
		})
	})
})

describe("priorSignals", () => {
	it("separates present from applied, and cross-checks against the emissions matrix", () => {
		const signals = priorSignals(
			trace({
				priors: [
					{ kind: "fst", applied: true },
					{ kind: "queryShape", applied: false },
				],
				emissions: [
					[1.5, 0],
					[0, 1],
				],
			})
		)

		expect(signals.present).toEqual(["fst", "queryShape"])
		expect(signals.applied).toEqual(["fst"])
		expect(signals.emissions_moved).toBe(true)
	})

	it("reads untouched emissions as unmoved", () => {
		expect(priorSignals(trace()).emissions_moved).toBe(false)
	})
})

describe("aggregateCensus — the inert verdict", () => {
	it("reports a mechanism that ran everywhere and moved nothing as inert, with that exact distinction", () => {
		const rows = [
			{ id: "a", input: "a", parse: trace({ priors: [{ kind: "fst", applied: false }] }) },
			{ id: "b", input: "b", parse: trace({ priors: [{ kind: "fst", applied: false }] }) },
		]

		const { aggregate } = aggregateCensus(rows)
		const fst = aggregate.inert.find((entry) => entry.mechanism === "fst")

		expect(fst).toBeDefined()
		expect(fst!.l0_present).toBe(2)
		expect(fst!.note).toContain("ran everywhere, moved nothing")
	})

	it("distinguishes never-present from present-but-dead", () => {
		const { aggregate } = aggregateCensus([{ id: "a", input: "a", parse: trace() }])
		const fst = aggregate.inert.find((entry) => entry.mechanism === "fst")

		expect(fst!.note).toContain("Never present")
	})

	it("does not report a mechanism that fired once as inert", () => {
		const rows = [
			{ id: "a", input: "a", parse: trace({ priors: [{ kind: "fst", applied: false }] }) },
			{ id: "b", input: "b", parse: trace({ priors: [{ kind: "fst", applied: true }] }) },
		]

		const { aggregate } = aggregateCensus(rows)

		expect(aggregate.inert.some((entry) => entry.mechanism === "fst")).toBe(false)
		expect(aggregate.priors.fst).toEqual({ l0_present: 2, l1_applied: 1 })
	})

	it("reports a channel that was fed zeros on every row as inert, separately from an absent one", () => {
		const rows = [
			{ id: "a", input: "a", parse: trace({ gazetteer: SILENT }) },
			{ id: "b", input: "b", parse: trace({ gazetteer: SILENT }) },
		]

		const { aggregate } = aggregateCensus(rows)
		const gazetteer = aggregate.inert.find((entry) => entry.mechanism === "channel:gazetteer")
		const anchor = aggregate.inert.find((entry) => entry.mechanism === "channel:anchor")

		expect(gazetteer!.note).toContain("fed ZEROS every time")
		expect(anchor!.note).toContain("absent from every trace")
	})

	it("routes an allowlisted mechanism to the allowlist, never to inert", () => {
		const rows = [{ id: "a", input: "a", parse: trace({ priors: [{ kind: "placetypeCensus", applied: false }] }) }]
		const { aggregate } = aggregateCensus(rows)

		expect(aggregate.inert.some((entry) => entry.mechanism === "placetypeCensus")).toBe(false)

		const entry = aggregate.allowlisted.find((item) => item.mechanism === "placetypeCensus")

		expect(entry).toBeDefined()
		expect(entry!.expectation_held).toBe(true)
		expect(CENSUS_ALLOWLIST["placetypeCensus"]).toBeDefined()
	})

	it("flags an allowlisted mechanism that FIRES — the reason on file is then stale", () => {
		const rows = [{ id: "a", input: "a", parse: trace({ priors: [{ kind: "placetypeCensus", applied: true }] }) }]
		const { aggregate } = aggregateCensus(rows)

		const entry = aggregate.allowlisted.find((item) => item.mechanism === "placetypeCensus")

		expect(entry!.expectation_held).toBe(false)
	})

	it("collects the starvation list completely, by row id", () => {
		const rows = [
			{ id: "starved", input: "s", parse: trace({ gazetteer: SILENT, country: SILENT }) },
			{ id: "fed", input: "f", parse: trace({ gazetteer: FIRED }) },
			{ id: "unconfigured", input: "u", parse: trace() },
		]

		const { aggregate } = aggregateCensus(rows)

		expect(aggregate.evidence_silent_rows).toEqual(["starved"])
	})

	it("tallies repairs by pass and only when they changed something", () => {
		const rows = [
			{
				id: "a",
				input: "a",
				parse: trace({ repairs: [{ pass: "postcodeRepair", before: ["O"], after: ["B-postcode"] }] }),
			},
			{ id: "b", input: "b", parse: trace() },
		]

		const { aggregate } = aggregateCensus(rows)

		expect(aggregate.repairs).toEqual({ postcodeRepair: 1 })
	})
})
