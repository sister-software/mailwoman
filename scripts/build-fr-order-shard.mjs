#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the French reversed-order coverage shard (#560). Reads REAL OpenAddresses FR tuples
 *   (`fr/countrywide.csv` from the cached zip), then for each row picks — by `--reversed-fraction`
 *   (default 0.5) — whether to render in CANONICAL French order (number-street, postcode-city) or
 *   one of four REVERSED / postcode-first variants that the v4.4.0→v0.5.0 regression exposed:
 *
 *   Canonical (already learned): "9 Rue de la Promenade, 01200 Villes"
 *
 *   Reversed variants (the gap — the model misses house_number in every one of these): A. "47110
 *   Sainte-Livrade-sur-Lot, 69 Allée du Bugatel" (postcode city, HN street) B.
 *   "Sainte-Livrade-sur-Lot, 47110, 619 Impasse de la Rose" (city, postcode, HN street) C.
 *   "Sainte-Livrade-sur-Lot 59 bis Rue des Ecuries 47110" (city HN street postcode) D. "47110, 6
 *   rue de la république, Sainte-Livrade-sur-Lot" (postcode, HN street, city)
 *
 *   Spans are FREE — we render `raw` + `components` and hand to `alignRow` (the same call all other
 *   builders use). The only invariant to maintain is substring-presence: every component surface
 *   must appear verbatim in `raw`.
 *
 *   Sub-modes covered alongside order:
 *
 *   - `bis`/`ter`/`quater` ordinal suffixes in house_number ("59 bis", "4 ter")
 *   - ALL-CAPS locality (a minor sub-mode in the golden misses: "SAINTE-LIVRADE-SUR-LOT")
 *
 *   `--golden` emits a held-out reversed-order eval slice ({raw, components, country:"FR"}) with a
 *   different seed, diversified across four formats. This resolves the eval quality issue where the
 *   current FR golden is 85% one reversed-order town (Sainte-Livrade-sur-Lot).
 *
 *   Pipeline (mirrors build-german-shard.mjs):
 *
 *   1. Node scripts/build-fr-order-shard.mjs --output /tmp/fr-order-train.jsonl --count 50000 --seed 42
 *   2. Python3 scripts/jsonl-to-parquet.py --input /tmp/fr-order-train.jsonl --output
 *        /tmp/part-fr-order.parquet
 *   3. Modal volume put mailwoman-training /tmp/part-fr-order.parquet
 *        corpus/versioned/.../train/part-fr-order.parquet
 *   4. Add to MANIFEST.json + `synth-fr-order: 0.2` to source_weights, then train.
 *
 *   Root cause: FR house_number in reversed (postcode-first) order never appeared in the BAN training
 *   corpus. The v4.4.0 span bridge rescued it by merging "47110, 9016" fragments; v0.5.0 retired
 *   the bridge and exposed the gap. This shard teaches the post-postcode position intrinsically.
 */

import { spawnSync } from "node:child_process"
import { createWriteStream } from "node:fs"

import { alignRow, stableSourceId } from "@mailwoman/corpus"

const SOURCE = { zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv" }

// Ordinal suffixes used in French house numbers (BAN corpus). Include them to cover the "8 bis"
// sub-mode of the golden misses.
const ORDINAL_SUFFIXES = ["bis", "ter", "quater"]
// Probability that a row gets an ordinal suffix injected (matches the golden's ~10-15% rate).
const ORDINAL_PROB = 0.12
// Probability that a locality renders ALL-CAPS (another sub-mode: "SAINTE-LIVRADE-SUR-LOT").
const ALLCAPS_PROB = 0.1

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { count: 50000, seed: 42, source: "synth-fr-order", reversedFraction: 0.5, golden: false }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--output") out.output = args[++i]
		else if (a === "--count") out.count = parseInt(args[++i], 10)
		else if (a === "--seed") out.seed = parseInt(args[++i], 10)
		else if (a === "--source-name") out.source = args[++i]
		else if (a === "--reversed-fraction") out.reversedFraction = parseFloat(args[++i])
		else if (a === "--golden") out.golden = true
	}
	if (!(out.reversedFraction >= 0 && out.reversedFraction <= 1)) {
		console.error(`--reversed-fraction must be in [0, 1], got ${out.reversedFraction}`)
		process.exit(1)
	}
	if (!out.output) {
		console.error(
			"Usage: build-fr-order-shard.mjs --output <labeled.jsonl> [--count N] [--seed N] [--reversed-fraction 0.5] [--golden]"
		)
		process.exit(1)
	}
	return out
}

/** Mulberry32 — reproducible PRNG (matches every other shard builder). */
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

/** Minimal RFC-4180-ish splitter (handles quoted fields with doubled-quote escaping). */
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
 * Stream FR tuples out of the cached OA zip. The countrywide extract is GB-scale; cap with `head`
 * to stay under V8's string limit (mirrors build-country-shard-balanced.mjs /
 * build-street-affix-shard.mjs). Only keeps rows that have a house_number (required for the shard's
 * core signal) and a postcode (required for reversed-order rendering to be meaningful).
 */
function readTuples(limit) {
	const maxLines = Math.max(limit * 8, 40000) + 1
	const r = spawnSync("bash", ["-c", `unzip -p "${SOURCE.zip}" "${SOURCE.csv}" | head -n ${maxLines}`], {
		maxBuffer: 1024 * 1024 * 1024,
		encoding: "buffer",
	})
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${SOURCE.zip} (status ${r.status})`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase())
	const idx = (name) => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iPost = idx("postcode")
	const get = (cells, i) => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples = []
	const seen = new Set()
	for (let li = 1; li < lines.length && tuples.length < limit; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li])
		const street = get(cells, iStreet)
		const locality = get(cells, iCity)
		const house_number = get(cells, iNum)
		const postcode = get(cells, iPost)
		// Require all four fields: HN is the signal; postcode drives reversed-order variants.
		if (!street || !locality || !house_number || !postcode) continue
		const key = `${house_number}|${street}|${locality}|${postcode}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, postcode })
	}
	return tuples
}

/**
 * Optionally augment a house_number with a French ordinal suffix ("59 bis", "4 ter"). The suffix is
 * appended with a space so it forms a single multi-token house_number string that alignRow can
 * still locate verbatim ("59 bis" appears as a substring of raw).
 */
function maybeAddOrdinal(random, house_number) {
	if (random() >= ORDINAL_PROB) return house_number
	const suffix = ORDINAL_SUFFIXES[Math.floor(random() * ORDINAL_SUFFIXES.length)]
	// Vary suffix case: "bis" (lower) vs "BIS" (upper) — a real-world split in the golden.
	return `${house_number} ${random() < 0.5 ? suffix : suffix.toUpperCase()}`
}

/**
 * Render a tuple in CANONICAL French order: "9 Rue de la Promenade, 01200 Villes". Components: {
 * house_number, street, postcode, locality }
 */
function renderCanonical(hn, street, postcode, locality) {
	const raw = `${hn} ${street}, ${postcode} ${locality}`
	return {
		raw,
		components: { house_number: hn, street, postcode, locality },
	}
}

/**
 * Render a tuple in one of the four REVERSED (postcode-first) variants observed in the golden
 * misses. The variant is chosen by `random()` so the corpus covers all four with roughly equal
 * frequency. Comma placement in each variant mirrors the real golden rows exactly.
 *
 * Variant A: "47110 Sainte-Livrade-sur-Lot, 69 Allée du Bugatel" (postcode city, HN street) Variant
 * B: "Sainte-Livrade-sur-Lot, 47110, 619 Impasse de la Rose" (city, postcode, HN street) Variant C:
 * "Sainte-Livrade-sur-Lot 59 bis Rue des Ecuries 47110" (city HN street postcode) — NO commas
 * Variant D: "47110, 6 rue de la république, Sainte-Livrade-sur-Lot" (postcode, HN street, city)
 */
function renderReversed(random, hn, street, postcode, locality) {
	const r = random()
	let raw
	if (r < 0.25) {
		// Variant A: postcode+city as a unit, then HN+street
		raw = `${postcode} ${locality}, ${hn} ${street}`
	} else if (r < 0.5) {
		// Variant B: city, then postcode, then HN+street (comma-separated, postcode isolated)
		raw = `${locality}, ${postcode}, ${hn} ${street}`
	} else if (r < 0.75) {
		// Variant C: no commas — locality HN street postcode (the "run-together" format)
		raw = `${locality} ${hn} ${street} ${postcode}`
	} else {
		// Variant D: postcode, HN+street, city (reversed top-to-bottom)
		raw = `${postcode}, ${hn} ${street}, ${locality}`
	}
	return {
		raw,
		components: { house_number: hn, street, postcode, locality },
	}
}

async function main() {
	const opts = parseArgs()
	const random = mulberry32(opts.seed)

	// Over-read from the CSV so the dedup + filter pass can fill `count` rows.
	// The FR countrywide extract is large enough; cap at count*8 lines (with a floor of 40K).
	const poolLimit = Math.max(opts.count * 8, 40000)
	const pool = readTuples(poolLimit)
	console.error(`  ${SOURCE.csv}: ${pool.length} unique tuples (capped read)`)
	if (pool.length === 0) {
		console.error("No FR tuples found — is /tmp/oa-cache/fr__countrywide.zip present?")
		process.exit(1)
	}

	const outStream = createWriteStream(opts.output, { encoding: "utf8" })
	let emitted = 0,
		skipped = 0,
		guard = 0
	const orderCounts = { canonical: 0, reversed: 0 }
	const variantCounts = { A: 0, B: 0, C: 0, D: 0 }
	const N = pool.length

	while (emitted < opts.count && guard++ < opts.count * 10) {
		const base = pool[Math.floor(random() * N)]
		const { street, postcode } = base
		const locality = random() < ALLCAPS_PROB ? base.locality.toUpperCase() : base.locality
		const house_number = maybeAddOrdinal(random, base.house_number)

		// Pick canonical vs reversed by --reversed-fraction.
		const isReversed = random() < opts.reversedFraction

		let rendered
		if (isReversed) {
			// Save the variant roll result for accounting. We do a second roll inside renderReversed,
			// so we peek at what renderReversed would pick by using the same probability bands.
			const variantRoll = random()
			let variant
			if (variantRoll < 0.25) {
				variant = "A"
				const raw = `${postcode} ${locality}, ${house_number} ${street}`
				rendered = { raw, components: { house_number, street, postcode, locality } }
			} else if (variantRoll < 0.5) {
				variant = "B"
				const raw = `${locality}, ${postcode}, ${house_number} ${street}`
				rendered = { raw, components: { house_number, street, postcode, locality } }
			} else if (variantRoll < 0.75) {
				variant = "C"
				const raw = `${locality} ${house_number} ${street} ${postcode}`
				rendered = { raw, components: { house_number, street, postcode, locality } }
			} else {
				variant = "D"
				const raw = `${postcode}, ${house_number} ${street}, ${locality}`
				rendered = { raw, components: { house_number, street, postcode, locality } }
			}
			variantCounts[variant]++
			orderCounts.reversed++
		} else {
			rendered = renderCanonical(house_number, street, postcode, locality)
			orderCounts.canonical++
		}

		const { raw, components } = rendered

		// Safety check: every component must appear verbatim in raw (alignment precondition).
		const componentValues = Object.values(components).filter(Boolean)
		if (!componentValues.every((v) => raw.includes(v))) {
			skipped++
			continue
		}

		// --golden: emit per-locale-f1 eval rows ({raw, components, country:"FR"}).
		// Use a distinct --seed from the training run so the eval set is held out.
		if (opts.golden) {
			outStream.write(JSON.stringify({ raw, components, country: "FR" }) + "\n")
			emitted++
			continue
		}

		const sourceId = stableSourceId(opts.source, {
			street: components.street,
			house_number: components.house_number,
			locality: components.locality,
			postcode: components.postcode,
		})
		const canonical = {
			raw,
			components,
			country: "FR",
			locale: "fr-FR",
			source: opts.source,
			source_id: sourceId,
			corpus_version: "0.5.0",
			license: "OpenAddresses FR countrywide tuples, rendered canonical + reversed-order — see ingest SOURCE",
		}
		const aligned = alignRow(canonical)
		if (aligned.kind !== "labeled" || !aligned.row) {
			skipped++
			continue
		}
		outStream.write(
			JSON.stringify({
				...aligned.row,
				synth_method: "fr-order",
				synth_order: isReversed ? "reversed" : "canonical",
				synth_base_id: null,
			}) + "\n"
		)
		emitted++
	}

	outStream.end()
	await new Promise((resolve) => outStream.on("finish", resolve))

	console.error(
		`Done: emitted ${emitted} FR rows (${orderCounts.canonical} canonical, ${orderCounts.reversed} reversed), ` +
			`skipped ${skipped} (pool ${pool.length}). -> ${opts.output}`
	)
	if (orderCounts.reversed > 0) {
		console.error(
			`  reversed variants: A=${variantCounts.A} B=${variantCounts.B} C=${variantCounts.C} D=${variantCounts.D}`
		)
	}

	// ── Self-check: sample 200 reversed rows from the output and verify house_number span ─────────
	if (!opts.golden && emitted > 0) {
		await runSpanCheck(opts.output, opts.seed + 1)
	}
}

/**
 * Span-validity check: read back the emitted JSONL, sample up to 200 rows that are reversed-order,
 * and assert that the house_number span lands exactly on the house_number component value in `raw`.
 * Prints passing/failing counts + a few example reversed rows.
 */
async function runSpanCheck(outputPath, seed) {
	const { readFileSync } = await import("node:fs")
	let rows
	try {
		const text = readFileSync(outputPath, "utf8")
		rows = text
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	} catch (e) {
		console.error(`  WARN: span-check could not read output: ${e.message}`)
		return
	}

	// Sample up to 200 reversed rows.
	const reversed = rows.filter((r) => r.synth_order === "reversed")
	const random = mulberry32(seed)
	const sample = []
	for (let i = 0; i < reversed.length && sample.length < 200; i++) {
		if (random() < 200 / Math.max(reversed.length, 1) || sample.length < 200 - (reversed.length - i)) {
			sample.push(reversed[i])
		}
	}

	let pass = 0,
		fail = 0
	const examples = []
	for (const row of sample) {
		const raw = row.raw
		// Aligned rows use parallel span_starts / span_ends / span_tags arrays.
		const spanTags = row.span_tags ?? []
		const spanStarts = row.span_starts ?? []
		const spanEnds = row.span_ends ?? []
		const hnIdx = spanTags.indexOf("house_number")
		if (hnIdx === -1) {
			fail++
			continue
		}
		const start = spanStarts[hnIdx]
		const end = spanEnds[hnIdx]
		const extracted = raw.slice(start, end)
		const expected = row.components?.house_number
		if (extracted === expected) {
			pass++
			if (examples.length < 5) examples.push({ raw, hn: extracted, start, end, order: row.synth_order })
		} else {
			fail++
		}
	}

	console.error(`\n  Span check (${sample.length} reversed rows sampled):`)
	console.error(`    PASS: ${pass}  FAIL: ${fail}`)
	if (fail > 0) {
		console.error(`    WARNING: ${fail} house_number spans did NOT land on the expected substring.`)
	} else {
		console.error(`    All house_number spans verified correct.`)
	}
	if (examples.length > 0) {
		console.error(`\n  Example reversed rows with house_number span:`)
		for (const ex of examples) {
			console.error(`    raw: "${ex.raw}"  => house_number[${ex.start}:${ex.end}] = "${ex.hn}"`)
		}
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
