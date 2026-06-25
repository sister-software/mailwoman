#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the anchor-absorption counter-augmentation shard (#220/#723, Probe A1). Renders the 6-slice
 *   `synthesizeAnchorAbsorptionRow` mix (CASE-H / CASE-P-us-rural / CASE-P-de / anchor-fp /
 *   locale-ambig / standard), aligns each to BIO, writes a labeled JSONL ready for parquet. The
 *   LEADING 5-digit on CASE-H/anchor-fp/locale-ambig is sampled from the REAL US ZIPs in the
 *   postcode anchor lookup, so the shaped-painted anchor (`anchor_paint_mode=shaped`) fires on it
 *   exactly as inference does — that's the whole point: the model must learn to OVERRIDE a present
 *   anchor from context.
 *
 *   This is the A1 amplifier for the Probe A0 finding: shaped-painting ALONE flipped the
 *   leading-5-digit default to house_number (recovered CASE-H, eroded CASE-P postcode 99.3→86.5).
 *   The heavy CASE-P floor (35%) + the CASE-H/CASE-P contrast teaches the context discriminator
 *   instead of a flipped default.
 *
 *   Pipeline (mirrors build-german-shard.mjs):
 *
 *   1. Node scripts/build-anchor-absorption-shard.mjs --output /tmp/anchor-absorption-labeled.jsonl
 *        --count 50000
 *   2. Python3 scripts/jsonl-to-parquet.py --input /tmp/anchor-absorption-labeled.jsonl\
 *        --output /tmp/part-anchor-absorption-train.parquet
 *   3. Assemble the overlay manifest (base v0.9.2-multilocale-au + this shard, re-rooted to /data)
 *   4. Push to R2, sync, add `synth-anchor-absorption: 6.0` to source_weights, train.
 */

import { createWriteStream, readFileSync } from "node:fs"

import { alignRow, stableSourceId, synthesizeAnchorAbsorptionRow } from "@mailwoman/corpus"

const ANCHOR_LOOKUP = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 50000, seed: 42, source: "synth-anchor-absorption" }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
	}
	if (!out.output) {
		console.error("Usage: build-anchor-absorption-shard.mjs --output <labeled.jsonl> [--count 50000] [--seed N]")
		process.exit(1)
	}
	return out
}

/** Deterministic LCG so a given --seed reproduces the shard bit-for-bit. */
function lcg(seed) {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 0x100000000
	}
}

function loadRealUsZips() {
	const d = JSON.parse(readFileSync(ANCHOR_LOOKUP, "utf8"))
	const zips = []
	for (const [pc, v] of Object.entries(d)) {
		if (Array.isArray(v) && v[0] && typeof v[0] === "object" && "US" in v[0] && /^\d{5}$/.test(pc)) zips.push(pc)
	}
	return zips
}

function main() {
	const opts = parseArgs()
	const random = lcg(opts.seed)
	const realZips = loadRealUsZips()
	console.error(`Loaded ${realZips.length} real US ZIPs from the anchor lookup (the leading-5-digit source).`)

	const outStream = createWriteStream(opts.output)
	let written = 0
	let quarantined = 0
	const byTemplate = {}
	for (let i = 0; i < opts.count; i++) {
		const synth = synthesizeAnchorAbsorptionRow({ random, realZips })
		const country = synth.locale.split("-")[1] // "en-US" -> "US", "de-DE" -> "DE"
		const canonical = {
			raw: synth.raw,
			components: synth.components,
			country,
			locale: synth.locale,
			source: opts.source,
			source_id: stableSourceId(opts.source, `${i}`),
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled") {
			quarantined++
			if (quarantined <= 5) console.error(`  quarantined: ${aligned.row?.reason} raw=${synth.raw}`)
			continue
		}
		outStream.write(
			JSON.stringify({ ...aligned.row, synth_method: "anchor-absorption", synth_template: synth.template }) + "\n"
		)
		written++
		byTemplate[synth.template] = (byTemplate[synth.template] ?? 0) + 1
	}
	outStream.end()
	console.error(`\nwrote ${written} rows (${quarantined} quarantined) → ${opts.output}`)
	console.error("  by slice:", JSON.stringify(byTemplate))
}

main()
