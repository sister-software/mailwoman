/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1102 diagnostic: class the US region/locality recall flips between the SHIPPED weights and a
 *   candidate (package-shaped cache dir). A "flip" = baseline extracted the gold value, candidate
 *   did not. Buckets name the mechanism so the counterweight change is one variable.
 *   Run from the repo root: `node packages/mailwoman/lib/dev-tools/us-recall-flip-census.run.ts <candidateCacheRoot> [sampleN]`
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import { JSONSpliterator } from "spliterator"

import { CLIUsageError } from "#cli-kit"

/**
 * Samples a bucket needs before its flip rate is worth reporting rather than noise.
 */
const MIN_REPORTABLE_SAMPLES = 4

const { positionals } = parseArguments({
	allowPositionals: true,
})

const [candidateRoot, sampleArg] = positionals

if (!candidateRoot) {
	throw new CLIUsageError("usage: us-recall-flip-census.run.ts <candidateCacheRoot> [sampleN]")
}

const SAMPLE = Number(sampleArg ?? 900)

interface GoldenRow {
	raw: string
	components: Record<string, string>
}

const rows: GoldenRow[] = (
	await Array.fromAsync(JSONSpliterator.fromAsync<GoldenRow>("data/eval/golden/v0.1.2/dev/us.jsonl"))
).slice(0, SAMPLE)

const baseline = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const candidate = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: candidateRoot })

async function extract(classifier: NeuralAddressClassifier, raw: string): Promise<Map<string, string[]>> {
	return groupTuplesByTag(await classifier.parse(raw, { postcodeRepair: true }))
}

interface FlipEntry {
	count: number
	where: Map<string, number>
	samples: string[]
}

const flips = new Map<string, FlipEntry>()

for (const row of rows) {
	const base = await extract(baseline, row.raw)
	const cand = await extract(candidate, row.raw)

	for (const tag of ["region", "locality"]) {
		const gold = row.components[tag]

		if (!gold) continue

		const baseHit = (base.get(tag) ?? []).some((v) => foldCaseWhitespace(v) === foldCaseWhitespace(gold))
		const candHit = (cand.get(tag) ?? []).some((v) => foldCaseWhitespace(v) === foldCaseWhitespace(gold))

		if (baseHit && !candHit) {
			// Where did the gold text GO in the candidate parse?
			let went = "dropped (no tag)"

			for (const [t, values] of cand.entries()) {
				if (t !== tag && values.some((v) => foldCaseWhitespace(v).includes(foldCaseWhitespace(gold)))) {
					went = `absorbed into ${t}`

					break
				}
			}

			const entry: FlipEntry = flips.get(tag) ?? { count: 0, where: new Map<string, number>(), samples: [] }

			entry.count++
			entry.where.set(went, (entry.where.get(went) ?? 0) + 1)

			if (entry.samples.length < MIN_REPORTABLE_SAMPLES) {
				entry.samples.push(`${JSON.stringify(row.raw)} gold ${tag}=${JSON.stringify(gold)} -> ${went}`)
			}

			flips.set(tag, entry)
		}
	}
}

for (const [tag, { count, where, samples }] of flips.entries()) {
	console.log(`\n=== US ${tag} flips (baseline hit -> candidate miss): ${count}/${rows.length} sampled ===`)

	for (const [went, n] of [...where.entries()].toSorted((a, b) => b[1] - a[1])) {
		console.log(`  ${went}: ${n}`)
	}

	for (const s of samples) {
		console.log(`   ${s}`)
	}
}
