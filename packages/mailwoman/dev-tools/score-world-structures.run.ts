/**
 * Shipped-model PARSER baseline for the permanent world-structures board added 2026-08-10 — 24 operator-supplied
 * real-world addresses from eleven countries, authored as frozen out-of-distribution evaluation cases.
 *
 * Sibling of `score-street-name-boundaries.run.ts` and `score-interesting-addresses.run.ts`, and deliberately the same
 * shape: exact per-tag span recall over the gauntlet rows selected by `source`, through `createRuntimePipeline`. This
 * measures the PARSE only. The coordinate, tier and place-identity gates those rows also carry are graded by the full
 * gauntlet runner against the ~9 GB shard set; nothing here touches them, so a clean score in this report is not a
 * claim that the row resolves.
 *
 * Every country in this batch grades through the en-US base model — none of the eleven has a shipped locale overlay.
 * For the two JP rows that limitation is the point rather than an accident: the JP-specific tags are the JP char
 * model's head vocabulary and the Latin model never emits them, so those assertions are unreachable by construction and
 * the report should show it.
 *
 * Usage: node packages/mailwoman/dev-tools/score-world-structures.run.ts
 */

import { type ComponentTag, decodeAsTuples } from "@mailwoman/core"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import { createRuntimePipeline } from "#index"

const SOURCE = "operator:world-structures-2026-08-10"

/**
 * The street family is assembled before comparison for the same reason the sibling boards do it: a row asserts the
 * whole attested street name, and a correct parse may split it across prefix/particle/name/suffix spans.
 */
const STREET_FAMILY = ["street_prefix", "street_prefix_particle", "street", "street_suffix"] as const

const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim()

const fixtures = (await loadRegressionCases()).filter((row) => row.source === SOURCE)

if (!fixtures.length) throw new Error(`No fixtures found for source ${SOURCE}.`)

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })

const perTag = new Map<string, { hit: number; total: number }>()
const perCountry = new Map<string, { hit: number; total: number }>()
const detail: string[] = []

for (const row of fixtures) {
	const result = await pipeline(row.input, { locale: "en-US" })
	const emitted = new Map<ComponentTag, string[]>()

	for (const [tag, value] of decodeAsTuples(result.tree)) {
		emitted.set(tag, [...(emitted.get(tag) ?? []), value])
	}

	let allHit = true
	const misses: string[] = []

	for (const [tag, expected] of Object.entries(row.expectComponents ?? {})) {
		const bucket = perTag.get(tag) ?? { hit: 0, total: 0 }

		bucket.total++
		perTag.set(tag, bucket)

		const actual = (
			tag === "street"
				? STREET_FAMILY.flatMap((part) => emitted.get(part) ?? [])
				: (emitted.get(tag as ComponentTag) ?? [])
		).join(" ")

		if (fold(actual) === fold(expected)) {
			bucket.hit++
		} else {
			allHit = false
			misses.push(`    ${tag.padEnd(20)} expect=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`)
		}
	}

	const country = perCountry.get(row.country) ?? { hit: 0, total: 0 }

	country.total++

	if (allHit) {
		country.hit++
	}

	perCountry.set(row.country, country)

	detail.push(`${allHit ? "PASS" : "FAIL"}  ${row.id}`)
	detail.push(...misses)
}

const caseTotal = fixtures.length
const caseHit = [...perCountry.values()].reduce((sum, score) => sum + score.hit, 0)

console.log(`\n=== world-structures board · shipped · parser-only ===`)
console.log(`cases exact: ${caseHit}/${caseTotal}\n`)

for (const [country, score] of [...perCountry].toSorted(([a], [b]) => a.localeCompare(b))) {
	console.log(`${country.padEnd(3)} ${String(score.hit).padStart(2)}/${score.total}`)
}

console.log("")

for (const [tag, score] of [...perTag].toSorted(([a], [b]) => a.localeCompare(b))) {
	console.log(`${tag.padEnd(22)} ${score.hit}/${score.total}`)
}

console.log(`\n--- per case ---`)
console.log(detail.join("\n"))
