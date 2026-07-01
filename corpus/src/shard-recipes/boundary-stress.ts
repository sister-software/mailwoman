/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `boundary-stress` shard recipe (#375) — the boundary-instability augmentation. Self-generates
 *   `--count` rows from {@link synthesizeBoundaryStressRow}'s weighted template mix (the v1.7.0,
 *   DeepSeek-tuned 2026-06-18 composition), aligns each to BIO, and emits a labeled JSONL. The
 *   lever for the taxonomy's #1 parser family (the boundary-wobble class). Ported from
 *   scripts/build-boundary-stress-shard.mjs.
 *
 *   `synthesizeBoundaryStressRow` is NOT re-exported from the corpus index — imported directly here.
 */

import { alignRow } from "../align.js"
import { type BoundaryStressTemplate, synthesizeBoundaryStressRow } from "../synthesize-boundary-stress.js"
import { makeMulberry32, type ShardRecipe, shardSourceID } from "./scaffold.js"

// Revised composition (v1.7.0, DeepSeek-tuned 2026-06-18): `bare-locality` ~11% (recover the 84% locality
// drop on bare "City, STATE" rows WITHOUT becoming a locality-first majority), and
// house-number-before:after = 7:3 (FR's dominant order is number-BEFORE; 30% after breaks the order-bias
// shortcut without risking FR hn-before accuracy). The three original non-number shapes keep the bulk.
// Weights sum to 1.0. Key order is load-bearing — it drives the cumulative thresholds below.
const WEIGHTS: Record<BoundaryStressTemplate, number> = {
	"street-eats-affix": 0.22,
	"comma-less-city-state": 0.22,
	"fr-prefix": 0.18,
	"bare-locality": 0.11,
	"house-number-before-street": 0.189,
	"house-number-after-street": 0.081,
}
const CUM: Array<[BoundaryStressTemplate, number]> = (() => {
	let acc = 0

	return (Object.entries(WEIGHTS) as Array<[BoundaryStressTemplate, number]>).map(
		([t, w]) => [t, (acc += w)] as [BoundaryStressTemplate, number]
	)
})()
function pickTemplate(r: () => number): BoundaryStressTemplate {
	const x = r()

	for (const [t, c] of CUM) if (x <= c) return t

	return CUM[CUM.length - 1]![0]
}

export const boundaryStressRecipe: ShardRecipe = {
	name: "boundary-stress",
	description: "Boundary-instability rows (#375): weighted template mix → synthesizeBoundaryStressRow → aligned BIO",
	mode: "generate",
	async run(opts, write) {
		// Emit PRNG: the legacy build-boundary-stress-shard.mjs seeded mulberry32(opts.seed).
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 20000
		let emitted = 0
		let skipped = 0

		for (let i = 0; i < count; i++) {
			const row = synthesizeBoundaryStressRow(undefined, { random, forceTemplate: pickTemplate(random) })
			const country = row.locale.split("-")[1] ?? "US"
			const source_id = shardSourceID("synth-boundary-stress", { ...row.components, v: String(i) })
			const canonical = {
				raw: row.raw,
				components: row.components,
				country,
				locale: row.locale,
				source: "synth-boundary-stress",
				source_id,
				corpus_version: "0.6.0",
				license: "Synthetic — boundary-stress; derived from public-domain locality/region tuples",
			}
			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled") {
				skipped++
				continue
			}
			// Match the base corpus parquet schema: flat synth_method / synth_base_id, not a nested `synth`.
			write(
				JSON.stringify({ ...aligned.row, synth_method: `boundary-stress:${row.template}`, synth_base_id: null }) + "\n"
			)
			emitted++
		}

		return { emitted, skipped }
	},
}
