#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the German coverage shard (night-shift 2026-06-02, DE-2). Reads REAL OpenAddresses German
 *   tuples (Berlin + Saxony, cached zips), renders each via `synthesizeGermanRow`, aligns to BIO, and
 *   writes a labeled JSONL ready for parquet.
 *
 *   ORDER ROBUSTNESS (2026-06-06): the shard now mixes TWO renderings of the same tuples —
 *   `--intl-fraction` (default 0.4) of rows in international order (house-number-FIRST,
 *   postcode-AFTER-city: `27 Straußstraße, Berlin, 12623`), the rest in idiomatic German order
 *   (house-AFTER-street, postcode-BEFORE-city: `Straußstraße 27, 12623 Berlin`). A native-only shard
 *   taught the model German order so well it traded away the US/feed order our own OA eval renders —
 *   making a healthy parser read as a "collapse." Teaching both layouts removes the trade.
 *   See `docs/articles/evals/2026-06-06-anchor-pilot.md` (the order-artifact correction).
 *
 *   Pipeline (mirrors build-intersection-shard.mjs):
 *
 *   1. Node scripts/build-german-shard.mjs --output /tmp/german-labeled.jsonl --count 4000
 *   2. Python3 scripts/jsonl-to-parquet.py --input /tmp/german-labeled.jsonl --output
 *        /tmp/part-german.parquet
 *   3. Modal volume put mailwoman-training /tmp/part-german.parquet
 *        corpus/versioned/v0.4.0/corpus-v0.4.0/train/part-german.parquet
 *   4. Add the parquet to that corpus's MANIFEST.json, then `synth-german: 0.2` to source_weights, then
 *        train.
 *
 *   German postcodes are 5-digit; UNIT/DISTRICT columns are ignored (admin-level coverage). Region is
 *   dropped by the synthesizer (the DE template absorbs the Bundesland into the city line).
 */

import { spawnSync } from "node:child_process"
import { createWriteStream } from "node:fs"

import { alignRow, stableSourceId, synthesizeGermanRow } from "@mailwoman/corpus"

const SOURCES = [
	{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv" },
	{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv" },
]

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 4000, seed: 42, source: "synth-german", intlFraction: 0.4 }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--intl-fraction") out.intlFraction = parseFloat(args[++i])
		else if (a === "--golden") out.golden = true
	}
	if (!(out.intlFraction >= 0 && out.intlFraction <= 1)) {
		console.error(`--intl-fraction must be in [0, 1], got ${out.intlFraction}`)
		process.exit(1)
	}
	if (!out.output) {
		console.error("Usage: build-german-shard.mjs --output <labeled.jsonl> [--count 4000] [--seed N]")
		process.exit(1)
	}
	return out
}

/** Mulberry32 — reproducible PRNG (matches the other shard builders). */
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

/** Minimal RFC-4180-ish splitter (handles quoted fields). */
function splitCsv(line) {
	const out = []
	let cur = ""
	let inQ = false
	for (let i = 0; i < line.length; i++) {
		const c = line[i]
		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else inQ = false
			} else cur += c
		} else if (c === '"') inQ = true
		else if (c === ",") {
			out.push(cur)
			cur = ""
		} else cur += c
	}
	out.push(cur)
	return out
}

/** Stream real German tuples out of a cached OA zip. */
function readTuples(source) {
	const r = spawnSync("unzip", ["-p", source.zip, source.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase())
	const idx = (name) => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iRegion = idx("region"),
		iPost = idx("postcode")
	const get = (cells, i) => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples = []
	const seen = new Set()
	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li])
		const street = get(cells, iStreet)
		const locality = get(cells, iCity)
		if (!street || !locality) continue
		const house_number = get(cells, iNum)
		const postcode = get(cells, iPost)
		const region = get(cells, iRegion)
		const key = `${house_number}|${street}|${locality}|${postcode}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, region, postcode })
	}
	return tuples
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)

	// Pool real tuples from every German source, then reservoir-sample to `count`.
	const pool = []
	for (const s of SOURCES) {
		const t = readTuples(s)
		console.error(`  ${s.csv}: ${t.length} unique tuples`)
		for (const x of t) pool.push(x) // NOT pool.push(...t) — spreading ~840K args overflows the stack
	}
	if (pool.length === 0) {
		console.error("No German tuples found — are the cached zips present in /tmp/oa-cache?")
		process.exit(1)
	}

	const outStream = createWriteStream(opts.output, { encoding: "utf8" })
	let emitted = 0
	let skipped = 0
	let guard = 0
	const orderCounts = { native: 0, international: 0 }
	const N = pool.length
	while (emitted < opts.count && guard++ < opts.count * 6) {
		const base = pool[Math.floor(random() * N)]
		// Per-row order: `--intl-fraction` of rows render house-first / postcode-after-city (the US/feed
		// layout), the rest in idiomatic German order. Same components either way — only the surface
		// layout (and thus the BIO ordering the model learns) changes.
		const order = random() < opts.intlFraction ? "international" : "native"
		const synth = synthesizeGermanRow(base, { random, order })
		if (!synth) {
			skipped++
			continue
		}
		// --golden: emit per-locale-f1 eval rows ({raw, components}) instead of aligned BIO. Use a
		// different --seed than the training shard so the eval set is held out from training. `order`
		// rides along so the eval can stratify native vs international.
		if (opts.golden) {
			outStream.write(JSON.stringify({ raw: synth.raw, components: synth.components, country: "DE", order }) + "\n")
			orderCounts[order]++
			emitted++
			continue
		}
		const sourceId = stableSourceId(opts.source, {
			street: synth.components.street,
			house_number: synth.components.house_number,
			locality: synth.components.locality,
			postcode: synth.components.postcode,
		})
		const canonical = {
			raw: synth.raw,
			components: synth.components,
			country: "DE",
			locale: synth.locale,
			source: opts.source,
			source_id: sourceId,
			corpus_version: "0.4.0",
			license: `OpenAddresses DE (Berlin/Saxony) tuples, rendered ${order}-order — see ingest SOURCES`,
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(JSON.stringify({ ...aligned.row, synth_method: "german", synth_order: order, synth_base_id: null }) + "\n")
		orderCounts[order]++
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(
		`Done: emitted ${emitted} German rows (${orderCounts.native} native, ${orderCounts.international} international), ` +
			`skipped ${skipped} (pool ${pool.length}). → ${opts.output}`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
