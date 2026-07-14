/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Probe-1 read-out (parity campaign): score a checkpoint on the held-out fragment-dev split with
 *   the pre-registered SEPARATOR metrics (campaign runbook / DeepSeek prediction 2):
 *
 *   - Token-level tag accuracy vs span-level EXACT match — a token-F1 rise with a lagging
 *       span-exact-match confirms the #727 span-head ceiling.
 *   - Trailing-number→postcode rate on street+number rows — persistence above noise confirms the
 *       numeric-neighbor confusion survives data.
 *
 *   Fixture: fragment-dev.jsonl (rows never trained on; schema = corpus rows). Grade candidates via
 *   `--weights-cache` package-shaped dirs ONLY (#718 zero-fill trap).
 */

import { readFileSync } from "node:fs"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"

export interface FragmentDevOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath: string
	/** Cap rows for a fast read (0 = all). */
	limit?: number
}

interface DevRow {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
}

const fold = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim()

/** Score fragment-dev; narrates the separator metrics and returns them for programmatic use. */
export async function runFragmentDev(options: FragmentDevOptions): Promise<{
	spanExact: number
	tagAccuracy: number
	trailingNumberToPostcode: number
}> {
	const rows: DevRow[] = readFileSync(options.fixturesPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as DevRow)
	const sample = options.limit && options.limit > 0 ? rows.slice(0, options.limit) : rows

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	let spanHits = 0
	let tagHits = 0
	let tagTotal = 0
	let numberRows = 0
	let numberAsPostcode = 0

	for (const row of sample) {
		const gold = row.span_tags.map((tag, i) => [tag, row.raw.slice(row.span_starts[i], row.span_ends[i])] as const)
		const tuples = decodeAsTuples(await classifier.parse(row.raw, { postcodeRepair: true }))
		const byTag = new Map<string, string[]>()

		for (const [tag, value] of tuples) {
			byTag.set(tag, [...(byTag.get(tag) ?? []), value])
		}

		// Span-exact: every gold span present under its tag with the exact folded value, and no
		// extra values under the gold tags.
		let exact = true

		for (const [tag, value] of gold) {
			tagTotal++
			const values = (byTag.get(tag) ?? []).map(fold)

			if (values.includes(fold(value))) {
				tagHits++
			} else {
				exact = false
			}
		}

		if (exact) {
			spanHits++
		}

		const numberGold = gold.find(([tag]) => tag === "house_number")

		if (numberGold) {
			numberRows++
			const postcodeValues = (byTag.get("postcode") ?? []).map(fold)

			if (postcodeValues.includes(fold(numberGold[1]))) {
				numberAsPostcode++
			}
		}
	}

	const spanExact = sample.length ? spanHits / sample.length : 0
	const tagAccuracy = tagTotal ? tagHits / tagTotal : 0
	const trailingNumberToPostcode = numberRows ? numberAsPostcode / numberRows : 0

	console.log(`fragment-dev: ${sample.length} rows`)
	console.log(`  span-exact           ${spanExact.toFixed(4)}`)
	console.log(`  tag-accuracy         ${tagAccuracy.toFixed(4)}`)
	console.log(`  number→postcode rate ${trailingNumberToPostcode.toFixed(4)} (${numberAsPostcode}/${numberRows})`)

	return { spanExact, tagAccuracy, trailingNumberToPostcode }
}
