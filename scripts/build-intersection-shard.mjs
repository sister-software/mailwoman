#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a JSONL of synthetic intersection training rows (v0.7 coverage fix).
 *
 *   The night-3 diagnostic found the model never learned intersection_a/b (~0.0001 prob; 65/376
 *   harness assertions at 0% neural) because the corpus has no intersection signal. This emits a
 *   small targeted supplement shard (synthesis-as-supplement discipline: weight < 0.25,
 *   one-and-done) of intersection rows, aligned to BIO and ready for jsonl-to-parquet.py.
 *
 *   Self-generating (no --input): draws city/region/zip from the synthesizer's built-in US base pool;
 *   street variety (cores/ordinals/directionals/suffixes/ connectors) is what teaches the
 *   city-independent intersection pattern.
 *
 *   Pipeline:
 *
 *   1. Node scripts/build-intersection-shard.mjs --output /tmp/intersection-labeled.jsonl --count 2000
 *        --seed 42
 *   2. Python3 scripts/jsonl-to-parquet.py --input /tmp/intersection-labeled.jsonl --output
 *        /tmp/part-intersection.parquet
 *   3. Modal volume put mailwoman-training /tmp/part-intersection.parquet
 *        corpus/versioned/v0.4.0/corpus-v0.4.0/train/part-intersection.parquet
 *   4. Add `synth-intersection: 0.2` to the training config source_weights, then train.
 */

import { createWriteStream } from "node:fs"

import { alignRow, DEFAULT_US_BASES, stableSourceId, synthesizeIntersectionRow } from "@mailwoman/corpus"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 2000, seed: 42, source: "synth-intersection" }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
	}
	if (!out.output) {
		console.error("Usage: build-intersection-shard.mjs --output <labeled.jsonl> [--count 2000] [--seed N]")
		process.exit(1)
	}
	return out
}

/** Mulberry32 — matches the synthesizer's test PRNG for reproducibility. */
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
	let guard = 0
	while (emitted < opts.count && guard++ < opts.count * 5) {
		const base = DEFAULT_US_BASES[emitted % DEFAULT_US_BASES.length]
		const synth = synthesizeIntersectionRow(base, { random })
		if (!synth) {
			skipped++
			continue
		}

		const sourceId = stableSourceId(opts.source, {
			intersection_a: synth.components.intersection_a,
			intersection_b: synth.components.intersection_b,
			locality: base.locality,
			region: base.region,
		})

		const canonical = {
			raw: synth.raw,
			components: synth.components,
			country: base.country,
			locale: synth.locale,
			source: opts.source,
			source_id: sourceId,
			corpus_version: "0.4.0",
			license: "Synthetic — US intersection templates, public-domain street/city pools",
		}

		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}

		const labeledRow = { ...aligned.row, synth_method: "intersection", synth_base_id: null }
		outStream.write(JSON.stringify(labeledRow) + "\n")
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(`Done: emitted ${emitted} intersection rows, skipped ${skipped}. → ${opts.output}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
