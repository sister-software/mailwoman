#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a JSONL of synthetic street-decomposition training rows for Stage 3.
 *   Pipeline: tuples JSONL → synthesizeStreetRow → alignRow → LabeledRow JSONL.
 *
 *   Usage:
 *     node scripts/build-street-shard.mjs \
 *       --input /tmp/tuples.jsonl \
 *       --output /tmp/street-labeled.jsonl \
 *       --variants 1 --seed 42
 */

import { createReadStream, createWriteStream } from "node:fs"
import { createInterface } from "node:readline"

import { alignRow, stableSourceId, synthesizeStreetRow } from "@mailwoman/corpus"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { variants: 1, seed: Date.now(), includeHouseNumberProb: 0.85 }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--input") out.input = args[++i]
		else if (a === "--output") out.output = args[++i]
		else if (a === "--variants") out.variants = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--house-number-prob") out.includeHouseNumberProb = parseFloat(args[++i])
	}
	if (!out.input || !out.output) {
		console.error("Usage: build-street-shard.mjs --input <tuples.jsonl> --output <labeled.jsonl> [--variants 1] [--seed N]")
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
	console.error(`  variants=${opts.variants} seed=${opts.seed} includeHN=${opts.includeHouseNumberProb}`)

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
		if (tuple.country !== "US") {
			skipped++
			continue
		}

		for (let v = 0; v < opts.variants; v++) {
			const synth = synthesizeStreetRow(tuple, { random, includeHouseNumberProb: opts.includeHouseNumberProb })
			if (!synth) continue

			const sourceId = stableSourceId("synth-street", {
				locality: `${tuple.locality}#${v}`,
				region: tuple.region,
				postcode: tuple.postcode,
				country: tuple.country,
			})

			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country: tuple.country,
				locale: synth.locale,
				source: "synth-street",
				source_id: sourceId,
				corpus_version: "0.4.0",
				license: "Synthetic — public-domain street name + tuple combination",
			}

			const aligned = alignRow(canonical)
			if (!aligned.row) {
				skipped++
				continue
			}

			const labeledRow = {
				...aligned.row,
				synth_method: "street-decomp",
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
