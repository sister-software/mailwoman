/**
 * Shipped-model parser baseline for the permanent multilingual bare-street board added 2026-08-09. The gauntlet stores
 * the assembled street as its contract; this report also prints the internal street-family decomposition so an intact
 * assembled value cannot hide a bad `street`/`street_suffix` boundary.
 *
 * Usage: node packages/mailwoman/lib/dev-tools/score-street-name-boundaries.run.ts
 */

import { groupTuplesByTag } from "@mailwoman/core"
import { STREET_FAMILY_TAGS } from "@mailwoman/core/types"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldNFKCWhitespace } from "@mailwoman/normalize/fold"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import { overlayLocale, routeCountry } from "#eval-harness/gauntlet/routing"
import { createRuntimePipeline } from "#index"

const SOURCE = "operator:street-name-audit-2026-08-09"

const fixtures = (await loadRegressionCases()).filter((row) => row.source === SOURCE)
const classifiers = new Map<string, Awaited<ReturnType<typeof NeuralAddressClassifier.loadFromWeights>>>()
const scores = new Map<string, { hit: number; total: number }>()
const failures: string[] = []

for (const row of fixtures) {
	const locale = overlayLocale(routeCountry(row))
	let classifier = classifiers.get(locale)

	if (!classifier) {
		classifier = await NeuralAddressClassifier.loadFromWeights({ locale })
		classifiers.set(locale, classifier)
	}

	const result = await createRuntimePipeline({ classifier })(row.input, { locale })
	const emitted = groupTuplesByTag(result.tree)

	const parts = STREET_FAMILY_TAGS.flatMap((tag) => emitted.get(tag) ?? [])
	const actual = parts.join(" ")
	const expected = row.expectComponents?.street ?? row.input
	const score = scores.get(row.country) ?? { hit: 0, total: 0 }

	score.total++
	scores.set(row.country, score)

	if (foldNFKCWhitespace(actual) === foldNFKCWhitespace(expected)) {
		score.hit++
	} else {
		const decomposition = STREET_FAMILY_TAGS.flatMap((tag) =>
			(emitted.get(tag) ?? []).map((value) => `${tag}=${JSON.stringify(value)}`)
		).join(" · ")

		failures.push(
			`${row.id}\texpect=${JSON.stringify(expected)}\tassembled=${JSON.stringify(actual)}\t${decomposition || "no street-family output"}`
		)
	}
}

const total = [...scores.values()].reduce((sum, score) => sum + score.total, 0)
const hit = [...scores.values()].reduce((sum, score) => sum + score.hit, 0)

console.log(`\n=== multilingual street-name boundary board · shipped ===`)
console.log(`cases exact: ${hit}/${total}`)

for (const [country, score] of [...scores].toSorted(([a], [b]) => a.localeCompare(b))) {
	console.log(`${country.padEnd(3)} ${String(score.hit).padStart(3)}/${score.total}`)
}

if (failures.length) {
	console.log("\nfailures:")

	for (const failure of failures) {
		console.log(failure)
	}
}
