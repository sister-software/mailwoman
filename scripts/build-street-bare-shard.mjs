/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Synthesize a BARE-STREET shard (v0.8.0 harness lever, 2026-06-05). The harness `functional.test.ts`
 *   cluster (32/34 fail on v0.7.2) is bare street names — "10th Ave", "Main St", "1 Main Pl" — that the
 *   model mislabels as `locality`, because `synthesizeStreetRow` only ever emitted streets WITH a
 *   ", City, ST ZIP" tail. This shard emits streets BARE (60%) — no tail, only `street_prefix`/`street`/
 *   `street_suffix` (+ optional `house_number`) — the bare-format analogue of the v0.7.x intersection-bare
 *   fix. Safe (US, in-distribution, no German-collapse risk).
 *
 *   Pipeline (same as the intersection shard):
 *     1. node scripts/build-street-bare-shard.mjs --output /tmp/street-bare-labeled.jsonl --count 3000 --seed 42
 *     2. python3 scripts/jsonl-to-parquet.py --input /tmp/street-bare-labeled.jsonl --output /tmp/part-street-bare.parquet
 *     3. modal volume put mailwoman-training /tmp/part-street-bare.parquet corpus/versioned/v0.4.0/corpus-v0.4.0/train/part-street-bare.parquet
 *     4. add `synth-street-bare: 0.2` to the training config source_weights, then train.
 */
import { createWriteStream } from "node:fs"

import { alignRow, DEFAULT_US_BASES, stableSourceId, synthesizeStreetRow } from "@mailwoman/corpus"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 3000, seed: 42, source: "synth-street-bare", bareProb: 0.6 }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--bare-prob") out.bareProb = parseFloat(args[++i])
	}
	if (!out.output) {
		console.error("Usage: node scripts/build-street-bare-shard.mjs --output <jsonl> [--count 3000] [--seed 42] [--bare-prob 0.6]")
		process.exit(1)
	}
	return out
}

/** mulberry32 — matches the synthesizer's test PRNG for reproducibility. */
function mulberry32(seed) {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)
	const outStream = createWriteStream(opts.output, { encoding: "utf8" })

	let emitted = 0
	let skipped = 0
	let bare = 0
	let guard = 0
	while (emitted < opts.count && guard++ < opts.count * 5) {
		const base = DEFAULT_US_BASES[emitted % DEFAULT_US_BASES.length]
		const synth = synthesizeStreetRow(base, { random, bareProb: opts.bareProb })
		if (!synth) {
			skipped++
			continue
		}
		const isBare = synth.components.region === undefined
		if (isBare) bare++

		const sourceId = stableSourceId(opts.source, {
			street: synth.components.street,
			street_suffix: synth.components.street_suffix,
			house_number: synth.components.house_number,
			bare: String(isBare),
			n: String(emitted),
		})

		const canonical = {
			raw: synth.raw,
			components: synth.components,
			country: base.country,
			locale: synth.locale,
			source: opts.source,
			source_id: sourceId,
			corpus_version: "0.4.0",
			license: "Synthetic — US street templates, public-domain street/city pools",
		}

		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}

		outStream.write(JSON.stringify({ ...aligned.row, synth_method: "street-bare", synth_base_id: null }) + "\n")
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(`Done: emitted ${emitted} street rows (${bare} bare, ${(100 * bare) / emitted}%), skipped ${skipped}. → ${opts.output}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
