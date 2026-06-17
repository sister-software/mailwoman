/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375: the "before" baseline for the boundary-instability stress shard (#703). Generates rows from
 *   each stress shape and parses them through the CURRENT neural model — how badly does today's model
 *   place these boundaries? Quantifies the #1-lever gap the shard targets + the lift a retrain should
 *   show. Per-shape, per-stress-tag exact-match accuracy (case-insensitive). Read-only.
 *   Run: node --experimental-strip-types scripts/eval/boundary-stress-baseline.ts [--n 300]
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import {
	type BoundaryStressTemplate,
	synthesizeBoundaryStressRow,
} from "../../corpus/src/synthesize-boundary-stress.ts"

const N = Number(process.argv[process.argv.indexOf("--n") + 1] || "300")
function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// The stress tag each shape is built to teach (the boundary the model wobbles on).
const STRESS_TAG: Record<BoundaryStressTemplate, string> = {
	"street-eats-affix": "street_suffix",
	"comma-less-city-state": "region",
	"fr-prefix": "street_prefix",
	"house-number-after-street": "house_number",
	"au-uk-slash-unit": "house_number",
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const random = mulberry32(20260617)

for (const template of Object.keys(STRESS_TAG) as BoundaryStressTemplate[]) {
	const tag = STRESS_TAG[template]
	let stressHit = 0
	const allKeys: Record<string, { hit: number; n: number }> = {}
	for (let i = 0; i < N; i++) {
		const row = synthesizeBoundaryStressRow(undefined, { random, forceTemplate: template })
		const json = decodeAsJson(await classifier.parse(row.raw, { postcodeRepair: true })) as Record<string, unknown>
		const got: Record<string, string> = {}
		const collect = (o: Record<string, unknown>): void => {
			for (const [k, v] of Object.entries(o)) {
				if (typeof v === "string") got[k] = v
				else if (v && typeof v === "object") collect(v as Record<string, unknown>)
			}
		}
		collect(json)
		for (const [k, gold] of Object.entries(row.components)) {
			const a = (allKeys[k] ??= { hit: 0, n: 0 })
			a.n++
			if ((got[k] ?? "").toLowerCase().trim() === String(gold).toLowerCase().trim()) a.hit++
		}
		if ((got[tag] ?? "").toLowerCase().trim() === String(row.components[tag as keyof typeof row.components] ?? "").toLowerCase().trim())
			stressHit++
	}
	console.log(`\n## ${template} (stress tag: ${tag})`)
	console.log(`  stress-tag exact: ${stressHit}/${N} (${((100 * stressHit) / N).toFixed(1)}%)`)
	const perKey = Object.entries(allKeys)
		.map(([k, a]) => `${k} ${((100 * a.hit) / a.n).toFixed(0)}%`)
		.join("  ")
	console.log(`  all tags: ${perKey}`)
}
