/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fr-order` shard recipe — French reversed-order coverage (#560). Reads REAL OpenAddresses FR
 *   tuples (`fr/countrywide.csv` from the cached zip), then for each row picks — by
 *   `--reversed-fraction` (default 0.5) — whether to render in CANONICAL French order
 *   (number-street, postcode-city) or one of four REVERSED / postcode-first variants the
 *   v4.4.0→v0.5.0 regression exposed (the model misses house_number in every reversed one):
 *
 *   - A: "47110 Sainte-Livrade-sur-Lot, 69 Allée du Bugatel" (postcode city, HN street)
 *   - B: "Sainte-Livrade-sur-Lot, 47110, 619 Impasse de la Rose" (city, postcode, HN street)
 *   - C: "Sainte-Livrade-sur-Lot 59 bis Rue des Ecuries 47110" (city HN street postcode — NO commas)
 *   - D: "47110, 6 rue de la république, Sainte-Livrade-sur-Lot" (postcode, HN street, city)
 *
 *   Sub-modes ride alongside order: `bis`/`ter`/`quater` ordinal suffixes in house_number, and
 *   ALL-CAPS locality. `--golden` emits a held-out reversed-order eval slice with a different
 *   seed.
 *
 *   The inline synthesis (the OA-CSV reader, the ordinal/all-caps tables, the canonical + reversed
 *   renderers) is ported faithfully from scripts/build-fr-order-shard.mjs. This is a
 *   `generate`-mode recipe that still reads REAL tuples off disk — `--count` bounds the OUTPUT, not
 *   the input. The passed `random` (the framework LCG) is consumed in the exact call order the
 *   legacy script used.
 *
 *   NOT ported (diagnostic-only, no effect on emitted bytes): the post-run `runSpanCheck` self-check
 *   (it reads the finished file back with a separate PRNG and prints to stderr; the recipe's output
 *   stream is still open during `run`), and the dead `renderReversed` helper (the legacy `main`
 *   inlined the variant logic and never called it).
 */

import { spawnSync } from "node:child_process"

import type { ComponentTag } from "@mailwoman/core/types"

import { stableSourceID } from "../adapter.js"
import { alignRow } from "../align.js"
import type { CanonicalRow } from "../types.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

const SOURCE = { zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv" }

// Ordinal suffixes used in French house numbers (BAN corpus), to cover the "8 bis" sub-mode.
const ORDINAL_SUFFIXES: readonly string[] = ["bis", "ter", "quater"]
// Probability that a row gets an ordinal suffix injected (matches the golden's ~10-15% rate).
const ORDINAL_PROB = 0.12
// Probability that a locality renders ALL-CAPS (another sub-mode: "SAINTE-LIVRADE-SUR-LOT").
const ALLCAPS_PROB = 0.1

/** A real FR tuple read out of the cached OA zip. */
interface FrTuple {
	house_number: string
	street: string
	locality: string
	postcode: string
}

/** Minimal RFC-4180-ish splitter (handles quoted fields with doubled-quote escaping). */
function splitCSV(line: string): string[] {
	const out: string[] = []
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
 * Stream FR tuples out of the cached OA zip. The countrywide extract is GB-scale; cap with `head` to stay under V8's
 * string limit. Only keeps rows with a house_number (the shard's core signal) and a postcode (required for
 * reversed-order rendering to be meaningful).
 */
function readTuples(limit: number): FrTuple[] {
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
	const header = splitCSV(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (name: string): number => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: FrTuple[] = []
	const seen = new Set<string>()

	for (let li = 1; li < lines.length && tuples.length < limit; li++) {
		if (!lines[li]) continue
		const cells = splitCSV(lines[li]!)
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
 * Optionally augment a house_number with a French ordinal suffix ("59 bis", "4 ter"). Appended with a space so it forms
 * one multi-token house_number string that alignRow can still locate verbatim.
 */
function maybeAddOrdinal(random: () => number, house_number: string): string {
	if (random() >= ORDINAL_PROB) return house_number
	const suffix = ORDINAL_SUFFIXES[Math.floor(random() * ORDINAL_SUFFIXES.length)]!

	// Vary suffix case: "bis" (lower) vs "BIS" (upper) — a real-world split in the golden.
	return `${house_number} ${random() < 0.5 ? suffix : suffix.toUpperCase()}`
}

/** Render a tuple in CANONICAL French order: "9 Rue de la Promenade, 01200 Villes". */
function renderCanonical(
	hn: string,
	street: string,
	postcode: string,
	locality: string
): { raw: string; components: Partial<Record<ComponentTag, string>> } {
	const raw = `${hn} ${street}, ${postcode} ${locality}`

	return { raw, components: { house_number: hn, street, postcode, locality } }
}

export const frOrderRecipe: ShardRecipe = {
	name: "fr-order",
	description: "French reversed-order rows (#560): real OA FR tuples rendered canonical + 4 postcode-first variants",
	mode: "generate",
	options: [
		{ flag: "--reversed-fraction <p>", description: "Fraction rendered reversed-order. Default 0.5" },
		{ flag: "--golden", description: "Emit the held-out reversed-order eval slice" },
	],
	async run(opts, write) {
		if (opts.count == null) throw new Error("fr-order recipe requires --count <N>")
		const count = opts.count
		// Legacy build-fr-order-shard.mjs seeded mulberry32 with the raw seed: `const random = mulberry32(opts.seed)`.
		// (The omitted diagnostic runSpanCheck used a separate mulberry32(opts.seed + 1) — not part of generation.)
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-fr-order"
		const reversedFraction = opts.reversedFraction ?? 0.5

		// Over-read from the CSV so the dedup + filter pass can fill `count` rows.
		const poolLimit = Math.max(count * 8, 40000)
		const pool = readTuples(poolLimit)
		console.error(`  ${SOURCE.csv}: ${pool.length} unique tuples (capped read)`)

		if (pool.length === 0) {
			throw new Error("No FR tuples found — is /tmp/oa-cache/fr__countrywide.zip present?")
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 10) {
			const base = pool[Math.floor(random() * N)]!
			const { street, postcode } = base
			const locality = random() < ALLCAPS_PROB ? base.locality.toUpperCase() : base.locality
			const house_number = maybeAddOrdinal(random, base.house_number)

			// Pick canonical vs reversed by --reversed-fraction.
			const isReversed = random() < reversedFraction

			let rendered: { raw: string; components: Partial<Record<ComponentTag, string>> }

			if (isReversed) {
				const variantRoll = random()
				let raw: string

				if (variantRoll < 0.25) {
					// Variant A: postcode+city as a unit, then HN+street
					raw = `${postcode} ${locality}, ${house_number} ${street}`
				} else if (variantRoll < 0.5) {
					// Variant B: city, then postcode, then HN+street (comma-separated, postcode isolated)
					raw = `${locality}, ${postcode}, ${house_number} ${street}`
				} else if (variantRoll < 0.75) {
					// Variant C: no commas — locality HN street postcode (the "run-together" format)
					raw = `${locality} ${house_number} ${street} ${postcode}`
				} else {
					// Variant D: postcode, HN+street, city (reversed top-to-bottom)
					raw = `${postcode}, ${house_number} ${street}, ${locality}`
				}
				rendered = { raw, components: { house_number, street, postcode, locality } }
			} else {
				rendered = renderCanonical(house_number, street, postcode, locality)
			}

			const { raw, components } = rendered

			// Safety check: every component must appear verbatim in raw (alignment precondition).
			const componentValues = Object.values(components).filter(Boolean) as string[]

			if (!componentValues.every((v) => raw.includes(v))) {
				skipped++
				continue
			}

			// --golden: emit per-locale-f1 eval rows ({raw, components, country:"FR"}).
			if (opts.golden) {
				write(JSON.stringify({ raw, components, country: "FR" }) + "\n")
				emitted++
				continue
			}

			const sourceID = stableSourceID(source, {
				street: components.street,
				house_number: components.house_number,
				locality: components.locality,
				postcode: components.postcode,
			})
			const canonical: CanonicalRow = {
				raw,
				components,
				country: "FR",
				locale: "fr-FR",
				source,
				source_id: sourceID,
				corpus_version: "0.5.0",
				license: "OpenAddresses FR countrywide tuples, rendered canonical + reversed-order — see ingest SOURCE",
			}
			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			write(
				JSON.stringify({
					...aligned.row,
					synth_method: "fr-order",
					synth_order: isReversed ? "reversed" : "canonical",
					synth_base_id: null,
				}) + "\n"
			)
			emitted++
		}

		return { emitted, skipped }
	},
}
