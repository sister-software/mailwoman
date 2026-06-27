/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `german` shard recipe — German coverage rows from REAL OpenAddresses tuples (Berlin + Saxony,
 *   cached zips). Each sampled tuple is rendered via {@link synthesizeGermanRow} in BOTH orders —
 *   `--intl-fraction` (default 0.4) in international order (house-first / postcode-after-city), the
 *   rest in idiomatic German order — then aligned to BIO. Generate-mode: it builds a tuple pool
 *   from the cached zips, then draws `--count` rows from it with the passed `random` (so the emit
 *   stream matches the legacy reservoir-sample loop). Ported from scripts/build-german-shard.mjs.
 *
 *   ORDER ROBUSTNESS (2026-06-06): mixing the two renderings stops a native-only shard from teaching
 *   German order so well it reads the US/feed-order eval as a "collapse". See
 *   docs/articles/evals/2026-06-06-anchor-pilot.md (the order-artifact correction).
 */

import { spawnSync } from "node:child_process"

import { stableSourceId } from "../adapter.js"
import { alignRow } from "../align.js"
import { synthesizeGermanRow, type LocaleBaseTuple } from "../synthesize-german.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

/** A German OA source (cached zip) + the Bundesland the file covers (OA's REGION column is empty for
DE). */
interface GermanSource {
	zip: string
	csv: string
	region: string
}

// `region` is the Bundesland the source covers. OA's REGION column is empty for DE, but the region is
// implied by the per-state file — the international order needs it for the "City, Region Postcode" tail
// (v0.9.3 / #327). berlin.csv → Berlin (a city-state, region==locality); sn/statewide → Sachsen.
const SOURCES: GermanSource[] = [
	{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv", region: "Berlin" },
	{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", region: "Sachsen" },
]

/** Minimal RFC-4180-ish splitter (handles quoted fields). */
function splitCsv(line: string): string[] {
	const out: string[] = []
	let cur = ""
	let inQ = false
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!
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

/** Stream real German tuples out of a cached OA zip (buffered `unzip -p`). */
function readGermanTuples(source: GermanSource): LocaleBaseTuple[] {
	const r = spawnSync("unzip", ["-p", source.zip, source.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (name: string): number => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iRegion = idx("region"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: LocaleBaseTuple[] = []
	const seen = new Set<string>()
	for (let li = 1; li < lines.length; li++) {
		const lineStr = lines[li]
		if (!lineStr) continue
		const cells = splitCsv(lineStr)
		const street = get(cells, iStreet)
		const locality = get(cells, iCity)
		if (!street || !locality) continue
		const house_number = get(cells, iNum)
		const postcode = get(cells, iPost)
		// OA's REGION column is empty for DE — fall back to the source's Bundesland (set per file).
		const region = get(cells, iRegion) || source.region || ""
		const key = `${house_number}|${street}|${locality}|${postcode}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, region, postcode })
	}
	return tuples
}

export const germanRecipe: ShardRecipe = {
	name: "german",
	description: "German coverage rows from real OA tuples (Berlin/Saxony), both orders → synthesizeGermanRow",
	mode: "generate",
	options: [{ flag: "--intl-fraction <f>", description: "Fraction rendered international order. Default 0.4" }],
	async run(opts, write) {
		// Emit PRNG: the legacy build-german-shard.mjs seeded mulberry32(opts.seed).
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-german"
		const intlFraction = opts.intlFraction ?? 0.4
		if (!(intlFraction >= 0 && intlFraction <= 1)) {
			throw new Error(`--intl-fraction must be in [0, 1], got ${intlFraction}`)
		}
		const count = opts.count ?? 4000

		// Pool real tuples from every German source, then sample `count` rows from it.
		const pool: LocaleBaseTuple[] = []
		for (const s of SOURCES) {
			const t = readGermanTuples(s)
			console.error(`  ${s.csv}: ${t.length} unique tuples`)
			for (const x of t) pool.push(x) // NOT pool.push(...t) — spreading ~840K args overflows the stack
		}
		if (pool.length === 0) {
			throw new Error("No German tuples found — are the cached zips present in /tmp/oa-cache?")
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length
		while (emitted < count && guard++ < count * 6) {
			const base = pool[Math.floor(random() * N)]!
			// Per-row order: `--intl-fraction` of rows render house-first / postcode-after-city (the US/feed
			// layout), the rest in idiomatic German order. Same components either way.
			const order = random() < intlFraction ? "international" : "native"
			const synth = synthesizeGermanRow(base, { random, order })
			if (!synth) {
				skipped++
				continue
			}
			// --golden: emit per-locale-f1 eval rows ({raw, components}) instead of aligned BIO. `order`
			// rides along so the eval can stratify native vs international.
			if (opts.golden) {
				write(JSON.stringify({ raw: synth.raw, components: synth.components, country: "DE", order }) + "\n")
				emitted++
				continue
			}
			const sourceId = stableSourceId(source, {
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
				source,
				source_id: sourceId,
				corpus_version: "0.4.0",
				license: `OpenAddresses DE (Berlin/Saxony) tuples, rendered ${order}-order — see ingest SOURCES`,
			}
			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])
			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			write(JSON.stringify({ ...aligned.row, synth_method: "german", synth_order: order, synth_base_id: null }) + "\n")
			emitted++
		}

		return { emitted, skipped }
	},
}
