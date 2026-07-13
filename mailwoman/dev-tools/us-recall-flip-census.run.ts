/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1102 diagnostic: class the US region/locality recall flips between the SHIPPED weights and a
 *   candidate (package-shaped cache dir). A "flip" = baseline extracted the gold value, candidate
 *   did not. Buckets name the mechanism so the counterweight lever is one variable.
 *   Run from the repo root: `node mailwoman/dev-tools/us-recall-flip-census.run.ts <candidateCacheRoot> [sampleN]`
 */

import { readFileSync } from "node:fs"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { cliArguments } from "@mailwoman/core/scripting/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const fold = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim()
const [candidateRoot, sampleArg] = cliArguments()

if (!candidateRoot) throw new Error("usage: us-recall-flip-census.run.ts <candidateCacheRoot> [sampleN]")

const SAMPLE = Number(sampleArg ?? 900)

interface GoldenRow {
	raw: string
	components: Record<string, string>
}

const rows: GoldenRow[] = readFileSync("data/eval/golden/v0.1.2/dev/us.jsonl", "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
	.slice(0, SAMPLE)

const baseline = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const candidate = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: candidateRoot })

async function extract(classifier: NeuralAddressClassifier, raw: string): Promise<Map<string, string[]>> {
	const byTag = new Map<string, string[]>()

	for (const [tag, value] of decodeAsTuples(await classifier.parse(raw, { postcodeRepair: true }))) {
		byTag.set(tag, [...(byTag.get(tag) ?? []), value])
	}

	return byTag
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

		const baseHit = (base.get(tag) ?? []).some((v) => fold(v) === fold(gold))
		const candHit = (cand.get(tag) ?? []).some((v) => fold(v) === fold(gold))

		if (baseHit && !candHit) {
			// Where did the gold text GO in the candidate parse?
			let went = "dropped (no tag)"

			for (const [t, values] of cand.entries()) {
				if (t !== tag && values.some((v) => fold(v).includes(fold(gold)))) {
					went = `absorbed into ${t}`
					break
				}
			}

			const entry: FlipEntry = flips.get(tag) ?? { count: 0, where: new Map<string, number>(), samples: [] }
			entry.count++
			entry.where.set(went, (entry.where.get(went) ?? 0) + 1)

			if (entry.samples.length < 4)
				entry.samples.push(`${JSON.stringify(row.raw)} gold ${tag}=${JSON.stringify(gold)} -> ${went}`)
			flips.set(tag, entry)
		}
	}
}

for (const [tag, { count, where, samples }] of flips.entries()) {
	console.log(`\n=== US ${tag} flips (baseline hit -> candidate miss): ${count}/${rows.length} sampled ===`)

	for (const [went, n] of [...where.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${went}: ${n}`)
	}

	for (const s of samples) console.log(`   ${s}`)
}
