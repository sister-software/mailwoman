/**
 * #1569/#1519 joint boundary board. Derives the held-out classes from golden v0.1.3 with the SAME classifier used by
 * the training shard, then scores a package-shaped fp32 candidate.
 *
 * Usage: node scripts/eval/score-suffix-boundary.ts --weights-cache <cache-root> [--json out.json]
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { runIfScript } from "@mailwoman/core/scripting"
import { classifySuffixBoundaryStreet } from "@mailwoman/corpus/shard-recipes/street-affix"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { parseArgs } from "@mailwoman/platform/util"
import { computeQueryShape } from "@mailwoman/query-shape"
import { JSONSpliterator } from "spliterator"

interface GoldenRow {
	raw: string
	components: Record<string, string>
}

interface Score {
	hit: number
	total: number
	rate: number
}

export interface SuffixBoundaryScore {
	target: Score
	contrast: Score
	toponymExact: Score
	toponymLocalityTokens: Score
	verdict: "PASS" | "FAIL"
}

const TOPONYMS: readonly GoldenRow[] = [
	{ raw: "Tel Aviv-Yafo", components: { locality: "Tel Aviv-Yafo" } },
	{ raw: "Port Louis", components: { locality: "Port Louis" } },
	{ raw: "Port of Spain", components: { locality: "Port of Spain" } },
]

// Frozen from golden v0.1.3/dev/us before the first #1569 training step.
const TARGET_TOTAL = 128
const TARGET_FLOOR = 116
const CONTRAST_TOTAL = 48
const CONTRAST_FLOOR = 34
const TOPONYM_TOKEN_FLOOR = 3

const fold = (value?: string): string => (value ?? "").trim().toUpperCase().replaceAll(/\s+/gu, " ")

function score(hit: number, total: number): Score {
	return { hit, total, rate: total ? hit / total : 0 }
}

function tokenHits(expected: string, actual: string): number {
	const remaining = actual.split(" ").filter((value) => value.length > 0)
	let hits = 0

	for (const token of expected.split(" ").filter((value) => value.length > 0)) {
		const index = remaining.indexOf(token)

		if (index === -1) continue

		remaining.splice(index, 1)

		hits++
	}

	return hits
}

export async function scoreSuffixBoundary(weightsCache: string): Promise<SuffixBoundaryScore> {
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: weightsCache })
	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<GoldenRow>("data/eval/golden/v0.1.3/dev/us.jsonl"))

	let targetHit = 0
	let targetTotal = 0
	let contrastHit = 0
	let contrastTotal = 0

	const predict = async (raw: string): Promise<Record<string, string>> =>
		decodeAsJSON(
			await classifier.parse(raw, {
				postcodeRepair: true,
				queryShape: computeQueryShape(raw),
			})
		) as Record<string, string>

	for (const row of rows) {
		const expectedStreet = fold(row.components.street)
		const expectedSuffix = fold(row.components.street_suffix)

		if (!expectedStreet || !expectedSuffix) continue

		const rowClass = classifySuffixBoundaryStreet(`${expectedStreet} ${expectedSuffix}`)

		if (!rowClass) continue

		const prediction = await predict(row.raw)
		const exact = fold(prediction.street) === expectedStreet && fold(prediction.street_suffix) === expectedSuffix

		if (rowClass === "terminal-only") {
			targetTotal++
			targetHit += Number(exact)
		} else {
			contrastTotal++
			contrastHit += Number(exact)
		}
	}

	if (targetTotal !== TARGET_TOTAL || contrastTotal !== CONTRAST_TOTAL) {
		throw new Error(
			`Board drift: expected target=${TARGET_TOTAL}/contrast=${CONTRAST_TOTAL}, got ${targetTotal}/${contrastTotal}`
		)
	}

	let toponymExact = 0
	let toponymTokenHit = 0
	let toponymTokenTotal = 0

	for (const row of TOPONYMS) {
		const expected = fold(row.components.locality)
		const actual = fold((await predict(row.raw)).locality)

		toponymExact += Number(actual === expected)
		toponymTokenHit += tokenHits(expected, actual)
		toponymTokenTotal += expected.split(" ").length
	}

	const result: SuffixBoundaryScore = {
		target: score(targetHit, targetTotal),
		contrast: score(contrastHit, contrastTotal),
		toponymExact: score(toponymExact, TOPONYMS.length),
		toponymLocalityTokens: score(toponymTokenHit, toponymTokenTotal),
		verdict:
			targetHit >= TARGET_FLOOR && contrastHit >= CONTRAST_FLOOR && toponymTokenHit >= TOPONYM_TOKEN_FLOOR
				? "PASS"
				: "FAIL",
	}

	return result
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			"weights-cache": { type: "string" },
			json: { type: "string" },
		},
	})

	if (!values["weights-cache"]) throw new Error("--weights-cache <cache-root> is required")

	const result = await scoreSuffixBoundary(values["weights-cache"])

	console.log("# #1569/#1519 joint boundary board — golden v0.1.3")
	console.log("| leg | result | bar |")
	console.log("| --- | ---: | ---: |")
	console.log(`| B1 terminal-only | ${result.target.hit}/${result.target.total} | >=116/128 |`)
	console.log(`| B2 terminal-contrast | ${result.contrast.hit}/${result.contrast.total} | >=34/48 |`)
	console.log(`| B4 toponym exact | ${result.toponymExact.hit}/${result.toponymExact.total} | watch |`)
	console.log(
		`| B4 toponym locality tokens | ${result.toponymLocalityTokens.hit}/${result.toponymLocalityTokens.total} | >=3/7 |`
	)
	console.log(`\nverdict: ${result.verdict}`)

	if (values.json) {
		await writeLocalJSONFile(result, values.json)
	}

	if (result.verdict === "FAIL") {
		process.exitCode = 1
	}
}

runIfScript(import.meta, main)
