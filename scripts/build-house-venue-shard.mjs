#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a JSONL of synthetic house_number+venue+street co-occurrence training rows for v0.6.3.
 *   Companion to `build-no-street-shard.mjs`. Reads `(locality, region, postcode, country, street?,
 *   houseNumber?)` tuples from JSONL stdin and emits aligned `LabeledRow` JSONL ready for the
 *   parquet sharding step.
 *
 *   This shard is the v0.6.3 corrective for the v0.6.2 house_number regression. The synth-no-street
 *   shard's distributional shift (adding ~122K rows with no house_number) trained the model to
 *   under-emit house_number; synth-house-venue restores the signal by producing rows where
 *   house_number AND venue coexist in the same address. See `corpus/src/synthesize-house-venue.ts`
 *   for the template design + rationale.
 *
 *   Usage: node scripts/build-house-venue-shard.mjs\
 *   --input /tmp/tuples.jsonl\
 *   --output /tmp/house-venue-labeled.jsonl\
 *   --variants 2 --seed 42
 */

import { createReadStream, createWriteStream } from "node:fs"
import { createInterface } from "node:readline"

import { alignRow, stableSourceId, synthesizeHouseVenueRow } from "@mailwoman/corpus"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { variants: 1, seed: Date.now(), source: "synth-house-venue" }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--input") out.input = args[++i]
		else if (a === "--output") out.output = args[++i]
		else if (a === "--variants") out.variants = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
	}
	if (!out.input || !out.output) {
		console.error(
			"Usage: build-house-venue-shard.mjs --input <tuples.jsonl> --output <labeled.jsonl> [--variants 1] [--seed N] [--source-name <s>]"
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
	console.error(`  variants=${opts.variants} seed=${opts.seed}`)

	const random = makeRandom(opts.seed)
	const inStream = createReadStream(opts.input, { encoding: "utf8" })
	const rl = createInterface({ input: inStream, crlfDelay: Infinity })
	const outStream = createWriteStream(opts.output, { encoding: "utf8" })

	let inputCount = 0
	let emitted = 0
	let skipped = 0
	const templateCounts = {}

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
			const synth = synthesizeHouseVenueRow(tuple, { random })
			if (!synth) {
				skipped++
				continue
			}

			templateCounts[synth.template] = (templateCounts[synth.template] ?? 0) + 1

			const sourceId = stableSourceId(opts.source, {
				locality: tuple.locality,
				region: tuple.region,
				postcode: tuple.postcode,
				country: tuple.country,
				template: synth.template,
				v: String(v),
			})

			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country: tuple.country,
				locale: synth.locale,
				source: opts.source,
				source_id: sourceId,
				corpus_version: "0.4.0",
				license: "Synthetic — derived from CC-BY / public-domain input tuples",
			}

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
	console.error(`Template distribution:`)
	for (const [tpl, count] of Object.entries(templateCounts).sort((a, b) => b[1] - a[1])) {
		const pct = ((100 * count) / emitted).toFixed(1)
		console.error(`  ${tpl}: ${count} (${pct}%)`)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
