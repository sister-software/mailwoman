#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a JSONL of synthetic PO box training rows. Reads (locality, region, postcode, country)
 *   tuples from an input JSONL stream (extracted upstream from existing corpus shards or any other
 *   source) and emits aligned LabeledRow JSONL ready for the parquet sharding step.
 *
 *   This is the TS-side glue between:
 *
 *   1. Tuple extraction (Python: read parquet → JSONL)
 *   2. PO box synthesis (this script: JSONL → labeled rows)
 *   3. Parquet sharding (Python: labeled JSONL → parquet)
 *
 *   Usage: node scripts/build-po-box-shard.mjs\
 *   --input /tmp/tuples.jsonl\
 *   --output /tmp/po-box-labeled.jsonl\
 *   --variants 3 --pmb-ratio 0.15 --seed 42
 */

import { createReadStream, createWriteStream } from "node:fs"
import { createInterface } from "node:readline"

import { alignRow, stableSourceId, synthesizePoBoxRow } from "@mailwoman/corpus"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { variants: 1, pmbRatio: 0.15, seed: Date.now() }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--input") out.input = args[++i]
		else if (a === "--output") out.output = args[++i]
		else if (a === "--variants") out.variants = parseInt(args[++i], 10)
		else if (a === "--pmb-ratio") out.pmbRatio = parseFloat(args[++i])
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
	}
	if (!out.input || !out.output) {
		console.error(
			"Usage: build-po-box-shard.mjs --input <tuples.jsonl> --output <labeled.jsonl> [--variants 1] [--pmb-ratio 0.15] [--seed N]"
		)
		process.exit(1)
	}
	return out
}

function makeRandom(seed) {
	let s = seed
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296
		return s / 4294967296
	}
}

async function main() {
	const opts = parseArgs()
	console.error(`Reading tuples from ${opts.input}, writing labeled rows to ${opts.output}...`)
	console.error(`  variants=${opts.variants} pmbRatio=${opts.pmbRatio} seed=${opts.seed}`)

	const random = makeRandom(opts.seed)
	const inStream = createReadStream(opts.input, { encoding: "utf8" })
	const rl = createInterface({ input: inStream, crlfDelay: Infinity })
	const outStream = createWriteStream(opts.output, { encoding: "utf8" })

	let inputCount = 0
	let emitted = 0
	let skipped = 0

	for await (const line of rl) {
		const trimmed = line.trim()
		if (!trimmed) continue
		inputCount++

		let tuple
		try {
			tuple = JSON.parse(trimmed)
		} catch {
			skipped++
			continue
		}
		if (!tuple.locality || !tuple.region || !tuple.postcode || !tuple.country) {
			skipped++
			continue
		}

		for (let v = 0; v < opts.variants; v++) {
			const synth = synthesizePoBoxRow(tuple, { random, pmbRatio: opts.pmbRatio })
			if (!synth) continue

			const sourceId = stableSourceId("synth-po-box", {
				locality: tuple.locality,
				region: tuple.region,
				postcode: tuple.postcode,
				country: tuple.country,
				v: String(v),
			})

			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country: tuple.country,
				locale: synth.locale,
				source: "synth-po-box",
				source_id: sourceId,
				corpus_version: "0.4.0",
				license: "Synthetic — derived from CC-BY / public-domain input tuples",
			}

			// Align: produce LabeledRow with tokens + labels arrays.
			const aligned = alignRow(canonical)
			if (!aligned.row) {
				skipped++
				continue
			}

			const labeledRow = {
				...aligned.row,
				synth_method: synth.template,
				synth_base_id: null,
			}

			outStream.write(JSON.stringify(labeledRow) + "\n")
			emitted++
		}
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(`\nDone: read ${inputCount} tuples, emitted ${emitted} rows, skipped ${skipped}.`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
