/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Plan-2 gate: the neural `/v1/parse` engine vs the phase-0 rules golden
 *   (mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl). Structured comparison, not
 *   byte-equality (spec §Projection layer, Plan-2 amendment 3): pre-registered per-label agreement
 *   floors after case-folding + street assembly. Skips when neural weights are absent (CI).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"

import { describe, expect, test } from "vitest"

interface GoldenRow {
	input: string
	outcome: { solutions: Array<{ classifications: Record<string, string[]> }> }
}

function weightsPresent(): boolean {
	try {
		return existsSync(realpathSync("neural-weights-en-us/model.onnx"))
	} catch {
		return false
	}
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

describe.skipIf(!weightsPresent())("v1-parse golden gate (neural vs rules baseline)", () => {
	test("pre-registered agreement floors hold", async () => {
		const { createServeEngine } = await import("../api-engine.ts")
		const { engine } = await createServeEngine()

		if (!engine.parse) throw new Error("weights present but parse engine missing")

		const rows = readFileSync("mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl", "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as GoldenRow)

		// Rules label → the fold of that label's golden value; street family concatenates for assembly parity.
		const FLOORS: Array<{ label: string; floor: number; neuralTags: string[] }> = [
			{ label: "house_number", floor: 0.97, neuralTags: ["house_number"] },
			{ label: "postcode", floor: 0.97, neuralTags: ["postcode"] },
			{
				label: "street",
				floor: 0.9,
				neuralTags: ["street_prefix", "street", "street_prefix_particle", "street_suffix"],
			},
		]

		const tallies = new Map(FLOORS.map((f) => [f.label, { hit: 0, total: 0 }]))

		for (const row of rows) {
			const golden = row.outcome.solutions[0]?.classifications ?? {}
			const outcome = await engine.parse(row.input, { debug: false })
			const byTag = new Map<string, string[]>()

			for (const { tag, value } of outcome.components) {
				byTag.set(tag, [...(byTag.get(tag) ?? []), value])
			}

			for (const { label, neuralTags } of FLOORS) {
				const goldenValues = golden[label]

				if (!goldenValues?.length) continue

				const tally = tallies.get(label)!
				tally.total++
				const neuralValue = neuralTags.flatMap((t) => byTag.get(t) ?? []).join(" ")

				if (fold(neuralValue) === fold(goldenValues.join(" "))) tally.hit++
			}
		}

		for (const { label, floor } of FLOORS) {
			const { hit, total } = tallies.get(label)!
			const rate = total ? hit / total : 1
			console.error(`gate ${label}: ${hit}/${total} = ${rate.toFixed(4)} (floor ${floor})`)
			expect(rate, `${label} agreement vs rules golden`).toBeGreaterThanOrEqual(floor)
		}
	}, 300_000)
})
