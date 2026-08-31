/**
 * Operator interesting-address board (2026-08-09): a focused projection of the PERMANENT gauntlet cases, not a second
 * answer key. Exact component-span recall for venue-heavy GB addresses and a bilingual JP pair; reviewed Google
 * normalization lives on each gauntlet row's source/coordinate/note and is not treated as parser gold.
 *
 * Usage: node packages/mailwoman/dev-tools/score-interesting-addresses.run.ts --country GB --label shipped node
 * packages/mailwoman/dev-tools/score-interesting-addresses.run.ts --country GB --cache-root <candidate> --label
 * candidate
 */

import { type ComponentTag, decodeAsTuples } from "@mailwoman/core"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import { createRuntimePipeline } from "#index"

const { values } = parseArguments({
	options: {
		country: { type: "string" },
		"cache-root": { type: "string" },
		label: { type: "string", default: "candidate" },
	},
})

const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim()

const fixtures = (await loadRegressionCases()).filter(
	(row) => row.id.includes("-interesting-") && (!values.country || row.country === values.country.toUpperCase())
)

if (!fixtures.length) throw new Error(`No fixtures selected${values.country ? ` for country ${values.country}` : ""}.`)

const perTag = new Map<ComponentTag, { hit: number; total: number }>()
let caseHit = 0
const failures: string[] = []

// Mirrors gauntlet/harness.ts today: GB has a shipped overlay; JP still grades through the base model until its
// package-shaped sibling model is wired into the gauntlet. Keeping that limitation visible is part of this board.
const localeForCountry = (country: string): string => (country === "GB" ? "en-GB" : "en-US")

for (const locale of new Set(fixtures.map((row) => localeForCountry(row.country)))) {
	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale,
		...(values["cache-root"] ? { cacheRoot: values["cache-root"] } : {}),
	})

	const pipeline = createRuntimePipeline({ classifier })

	for (const row of fixtures.filter((fixture) => localeForCountry(fixture.country) === locale)) {
		const result = await pipeline(row.input, { locale })
		const emitted = new Map<ComponentTag, string[]>()

		for (const [tag, value] of decodeAsTuples(result.tree)) {
			emitted.set(tag, [...(emitted.get(tag) ?? []), value])
		}

		let allHit = true

		for (const [tag, expected] of Object.entries(row.expectComponents ?? {}) as [ComponentTag, string][]) {
			const bucket = perTag.get(tag) ?? { hit: 0, total: 0 }

			bucket.total++
			perTag.set(tag, bucket)

			const actualValues =
				tag === "street"
					? ["street_prefix", "street_prefix_particle", "street", "street_suffix"].flatMap(
							(part) => emitted.get(part as ComponentTag) ?? []
						)
					: (emitted.get(tag) ?? [])

			const actual = actualValues.join(" ")

			if (fold(actual) === fold(expected)) {
				bucket.hit++
			} else {
				allHit = false
				failures.push(`${row.id}\t${tag}\texpect=${JSON.stringify(expected)}\tgot=${JSON.stringify(actual)}`)
			}
		}

		if (allHit) {
			caseHit++
		}
	}
}

console.log(`\n=== operator interesting addresses · ${values.label} ===`)
console.log(`cases exact: ${caseHit}/${fixtures.length}`)

for (const [tag, score] of [...perTag].toSorted(([a], [b]) => a.localeCompare(b))) {
	console.log(`${tag.padEnd(22)} ${score.hit}/${score.total}`)
}

if (failures.length) {
	console.log("\nfailures:")

	for (const failure of failures) {
		console.log(failure)
	}
}
