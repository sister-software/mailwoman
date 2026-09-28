/**
 * This measures the parse only, so a clean score here is not a claim that the row resolves.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { STREET_FAMILY_TAGS } from "@mailwoman/codex/component"
import { groupTuplesByTag } from "@mailwoman/core"
import { stringifyJSON } from "@mailwoman/core/json"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldNFKCWhitespace } from "@mailwoman/normalize/fold"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import { createRuntimePipeline } from "#index"

const SOURCE = "operator:world-structures-2026-08-10"

/**
 * The street family is assembled because a row asserts the whole attested street name
 * and a correct parse may split it across prefix/particle/name/suffix spans.
 */

const fixtures = (await loadRegressionCases()).filter((row) => row.source === SOURCE)

if (!fixtures.length) throw new Error(`No fixtures found for source ${SOURCE}.`)

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })

const perTag = new Map<string, { hit: number; total: number }>()
const perCountry = new Map<string, { hit: number; total: number }>()
const detail: string[] = []

for (const row of fixtures) {
	const result = await pipeline(row.input, { locale: "en-US" })
	const emitted = groupTuplesByTag(result.tree)

	let allHit = true
	const misses: string[] = []

	for (const [tag, expected] of Object.entries(row.expectComponents ?? {})) {
		const bucket = perTag.get(tag) ?? { hit: 0, total: 0 }

		bucket.total++
		perTag.set(tag, bucket)

		const actual = (
			tag === "street"
				? STREET_FAMILY_TAGS.flatMap((part) => emitted.get(part) ?? [])
				: (emitted.get(tag as ComponentTag) ?? [])
		).join(" ")

		if (foldNFKCWhitespace(actual) === foldNFKCWhitespace(expected)) {
			bucket.hit++
		} else {
			allHit = false
			misses.push(`    ${tag.padEnd(20)} expect=${stringifyJSON(expected)} got=${stringifyJSON(actual)}`)
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
