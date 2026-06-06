#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a per-locale coverage shard — the multi-locale generalization of build-german-shard.mjs
 *   (the "make it less special" mandate). Reads REAL OpenAddresses tuples for a `--country`, renders
 *   each via `synthesizeLocaleRow` in BOTH orders (`--intl-fraction`, default 0.4 = ~40% house-first /
 *   postcode-after-city international layout, the rest country-native), aligns to BIO, and writes a
 *   labeled JSONL ready for parquet. Order robustness is the point: a native-only shard teaches one
 *   layout so well it trades away the other (docs/articles/evals/2026-06-06-anchor-pilot.md).
 *
 *   readTuples STREAMS each CSV (`unzip -p | readline`) and reservoir-samples to {@link RESERVOIR_CAP},
 *   so FR/US-countrywide (~2.5 GB, ~25M rows) work in bounded memory — no buffer overflow, no OOM.
 *
 *   Country support (gated on cached OA data + clean verbatim alignment):
 *     DE — Berlin/Saxony; works (5-digit postcode; region from the per-state file, OA's column is empty).
 *     FR — countrywide; works (streamed + reservoir-sampled). OA's REGION column is empty for FR too, and
 *          the countrywide file spans all départements, so the international rows render WITHOUT a region
 *          tail until a postcode→région mapping is added (follow-up; less critical than DE since the FR
 *          eval differs).
 *     NL — countrywide; works both orders (postcode canonicalized to the spaced `1011 AB` form so the
 *          template aligns; OA's REGION column IS populated for NL, so the international tail carries it).
 *     ES/IT — no cached OA yet (fetch + add to COUNTRY_SOURCES to enable).
 *
 *   Pipeline (mirrors build-german-shard.mjs):
 *     node scripts/build-locale-shard.mjs --country FR --output /tmp/fr-train.jsonl --count 200000 --seed 42
 *     python3 scripts/jsonl-to-parquet.py --input /tmp/fr-train.jsonl --output <NEW>/train/part-fr-train.parquet
 *     # then assemble the overlay manifest + modal volume put, as for v0.4.2-de-bothorder.
 */

import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { createInterface } from "node:readline"

import { alignRow, stableSourceId, synthesizeLocaleRow } from "@mailwoman/corpus"

/**
 * Per-country OA sources (cached zips) + the source name used in the corpus. Each `{ zip, csv }` part
 * may carry a `region` fallback (the admin region the file covers) for countries whose OA REGION column
 * is empty — DE's is, so the international-order tail needs it set per-state (#327). FR/NL leave it unset
 * (their REGION column is populated, used per-row). Add ES/IT here once their OA dumps are fetched.
 */
const COUNTRY_SOURCES = {
	DE: { source: "synth-german", parts: [
		{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv", region: "Berlin" },
		{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", region: "Sachsen" },
	] },
	FR: { source: "synth-fr", parts: [
		{ zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv" },
	] },
	NL: { source: "synth-nl", parts: [
		{ zip: "/tmp/oa-cache/nl__countrywide.zip", csv: "nl/countrywide.csv" },
	] },
}

/**
 * Per-part reservoir cap. Streaming + Algorithm-R reservoir sampling to this size keeps memory bounded
 * (~CAP × ~0.2 KB ≈ 240 MB at 1.2M) regardless of source size, where buffering the whole CSV (the old
 * spawnSync path) OOMs / overflows the 1 GB buffer on FR/US-countrywide (~2.5 GB, ~25M rows). DE/NL-scale
 * sources (≤ ~1.2M) fit entirely, so they're sampled losslessly.
 */
const RESERVOIR_CAP = 1_200_000

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 4000, seed: 42, country: "DE", intlFraction: 0.4, source: null }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--country") out.country = String(args[++i]).toUpperCase()
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--intl-fraction") out.intlFraction = parseFloat(args[++i])
		else if (a === "--golden") out.golden = true
	}
	if (!out.output) {
		console.error("Usage: build-locale-shard.mjs --country <DE|FR|NL> --output <labeled.jsonl> [--count N] [--seed N] [--intl-fraction 0.4]")
		process.exit(1)
	}
	if (!COUNTRY_SOURCES[out.country]) {
		console.error(`No OA sources registered for --country ${out.country}. Known: ${Object.keys(COUNTRY_SOURCES).join(", ")}.`)
		process.exit(1)
	}
	if (!(out.intlFraction >= 0 && out.intlFraction <= 1)) {
		console.error(`--intl-fraction must be in [0, 1], got ${out.intlFraction}`)
		process.exit(1)
	}
	out.source = out.source ?? COUNTRY_SOURCES[out.country].source
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

/**
 * Stream real tuples out of a cached OA zip and reservoir-sample to {@link RESERVOIR_CAP}. Reads the CSV
 * line-by-line via `unzip -p | readline` (bounded memory) and keeps a uniform random sample (Algorithm R)
 * seeded by `rng` — separate from the emit loop's PRNG, so the sample is reproducible and doesn't perturb
 * the emit draws. NO global dedup: a 25M-key Set would OOM, and OA rows are near-unique so reservoir
 * dupes are negligible. OA's columns are stable across countries; the region falls back to `part.region`
 * when the row's REGION cell is empty (DE).
 */
function readTuples(part, rng) {
	return new Promise((resolve) => {
		const child = spawn("unzip", ["-p", part.zip, part.csv])
		const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
		const get = (cells, i) => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
		const reservoir = []
		let iNum, iStreet, iCity, iRegion, iPost
		let header = null
		let seen = 0
		rl.on("line", (line) => {
			if (!line) return
			if (header === null) {
				header = splitCsv(line).map((h) => h.trim().toLowerCase())
				const ix = (name) => header.indexOf(name)
				iNum = ix("number")
				iStreet = ix("street")
				iCity = ix("city")
				iRegion = ix("region")
				iPost = ix("postcode")
				return
			}
			const cells = splitCsv(line)
			const street = get(cells, iStreet)
			const locality = get(cells, iCity)
			if (!street || !locality) return
			const tuple = {
				house_number: get(cells, iNum),
				street,
				locality,
				region: get(cells, iRegion) || part.region || "",
				postcode: get(cells, iPost),
			}
			seen++
			if (reservoir.length < RESERVOIR_CAP) {
				reservoir.push(tuple)
			} else {
				const j = Math.floor(rng() * seen) // 0 .. seen-1
				if (j < RESERVOIR_CAP) reservoir[j] = tuple
			}
		})
		rl.on("close", () => {
			console.error(`  ${part.csv}: ${reservoir.length} sampled of ${seen} rows`)
			resolve(reservoir)
		})
		child.on("error", (err) => {
			console.error(`  WARN: unzip failed for ${part.zip}: ${err.message}`)
			resolve([])
		})
	})
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)
	const { parts } = COUNTRY_SOURCES[opts.country]

	const pool = []
	for (let pi = 0; pi < parts.length; pi++) {
		// A reservoir PRNG per part, seeded but independent of the emit loop's `random`, so the sample is
		// reproducible without perturbing the synth/order draws.
		const reservoirRng = mulberry32((opts.seed ^ (0x9e3779b9 * (pi + 1))) >>> 0)
		const t = await readTuples(parts[pi], reservoirRng)
		for (const x of t) pool.push(x) // NOT pool.push(...t) — spreading huge arrays overflows the stack
	}
	if (pool.length === 0) {
		console.error(`No ${opts.country} tuples found — are the cached zips present in /tmp/oa-cache?`)
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
		const order = random() < opts.intlFraction ? "international" : "native"
		const synth = synthesizeLocaleRow(base, opts.country, { random, order })
		if (!synth) {
			skipped++
			continue
		}
		if (opts.golden) {
			outStream.write(JSON.stringify({ raw: synth.raw, components: synth.components, country: opts.country, order }) + "\n")
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
			country: opts.country,
			locale: synth.locale,
			source: opts.source,
			source_id: sourceId,
			corpus_version: "0.4.0",
			license: `OpenAddresses ${opts.country} tuples, rendered ${order}-order — see ingest SOURCES`,
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(JSON.stringify({ ...aligned.row, synth_method: opts.source, synth_order: order, synth_base_id: null }) + "\n")
		orderCounts[order]++
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))
	console.error(
		`Done: emitted ${emitted} ${opts.country} rows (${orderCounts.native} native, ${orderCounts.international} international), ` +
			`skipped ${skipped} (pool ${pool.length}). → ${opts.output}`
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
