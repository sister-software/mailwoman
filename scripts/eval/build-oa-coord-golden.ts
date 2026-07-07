/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a representative, COORDINATE-BEARING held-out eval set for a non-US locale from a
 *   standard-schema OpenAddresses country dump (#229 Phase A).
 *
 *   Why this exists: the existing per-locale golden measures non-US labels thinly and
 *   unrepresentatively (the FR `region` rows, e.g., are synthetic multi-script + order permutations
 *   — see 2026-06-22-fr-eval-coverage-scorecard.md). Label-F1 on non-US is also confounded by
 *   labeling conventions (a Spanish "Calle Mayor" street boundary). The honest metric is the
 *   ASSEMBLED COORDINATE — so this builds rows that carry the truth lat/lon, graded by
 *   scripts/eval/fr-admin-split-gate.ts --default-country <CC> (parse -> resolve -> great-circle
 *   error), the metric we ship.
 *
 *   Source: a standard-schema OA countrywide CSV with LON,LAT,NUMBER,STREET,CITY,POSTCODE[,REGION]
 *   columns (IT/FR/most OA collections). The Spanish dump uses a different cadastral schema and is
 *   NOT handled here (label-only spot-check instead).
 *
 *   Sampling: bucket by REGION (or postcode prefix when REGION is absent) and cap per bucket, so the
 *   set spans the whole country, not the first province on disk. Render in three natural orders
 *   (canonical / postcode-first / locality-first) so the model isn't graded on one rigid template.
 *   Streams the CSV — OOM-safe on the multi-GB dumps.
 *
 *   Usage: node --experimental-strip-types scripts/eval/build-oa-coord-golden.ts --country IT\
 *   --zip /mnt/playpen/mailwoman-data/oa-cache/it__countrywide.zip\
 *   --entry it/countrywide.csv --out data/eval/external/oa-it-coord-150.jsonl --n 150
 *
 *   Ported faithfully from scripts/eval/build-oa-coord-golden.py. NOTE: the seeded RNG shuffle is
 *   distribution-faithful but NOT CPython-bit-identical (see python-random.ts);
 *   logic/filters/schema are preserved.
 */

import { globSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseArgs } from "node:util"

import { pyJsonDumps } from "../lib/python-json.ts"
import { SeededRandom } from "../lib/python-random.ts"
import { csvRecordsFromFile, csvRecordsFromZip } from "../lib/zip-csv.ts"

const ORDERS = ["canonical", "pc-first", "city-first"]

function render(street: string, num: string, cp: string, city: string, order: string): string {
	if (order === "canonical") return `${street} ${num}, ${cp} ${city}`

	if (order === "pc-first") return `${cp} ${city}, ${street} ${num}`

	return `${city}, ${cp}, ${street} ${num}`
}

/** Python `str.isupper()`: at least one cased char, and every cased char is uppercase. */
function pyIsUpper(s: string): boolean {
	let hasCased = false

	for (const ch of s) {
		const lo = ch.toLowerCase()
		const up = ch.toUpperCase()

		if (lo === up) continue // not a cased character
		hasCased = true

		if (ch !== up) return false // a cased char that isn't uppercase
	}

	return hasCased
}

/** Python `str.title()`: titlecase the first cased char of each run of cased chars, lowercase rest. */
function pyTitle(s: string): string {
	let out = ""
	let prevCased = false

	for (const ch of s) {
		const cased = ch.toLowerCase() !== ch.toUpperCase()
		out += prevCased ? ch.toLowerCase() : ch.toUpperCase()
		prevCased = cased
	}

	return out
}

function titlecaseIfUpper(s: string): string {
	return pyIsUpper(s) ? pyTitle(s) : s
}

/**
 * Python `float(s)` for coordinate strings: empty/non-numeric -> null (the ValueError -> continue path).
 */
function pyFloat(s: string | undefined): number | null {
	if (s == null) return null
	const t = s.trim()

	if (t === "") return null
	const v = Number(t)

	return Number.isNaN(v) ? null : v
}

interface Bucketed {
	street: string
	num: string
	cp: string
	city: string
	lat: number
	lon: number
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			country: { type: "string" },
			zip: { type: "string" },
			entry: { type: "string" },
			"csv-glob": { type: "string" },
			out: { type: "string" },
			n: { type: "string", default: "150" },
			"per-bucket": { type: "string", default: "8" },
			seed: { type: "string", default: "722" },
			// Per-bucket seeded reservoir sampling over the FULL stream, instead of the default
			// first-per-bucket-rows fill. The default fill takes each bucket's rows from wherever the
			// bucket key first appears in file order — for municipality-ordered dumps (OA CZ/PL) that
			// concentrates every bucket on one city, which under-disperses the localities the
			// wrong-city% metric needs (#291). Reservoir mode streams everything (no early stop), so it
			// costs a full pass; row selection stays deterministic per seed + input order.
			reservoir: { type: "boolean", default: false },
		},
	})

	for (const req of ["country", "out"] as const) {
		if (!values[req]) {
			process.stderr.write(`error: the following arguments are required: --${req}\n`)
			process.exit(2)
		}
	}
	const country = values.country!
	const out = values.out!
	const n = Number(values.n)
	const perBucket = Number(values["per-bucket"])
	const seed = Number(values.seed)

	const reservoir = values.reservoir
	const rng = new SeededRandom(seed)
	const buckets = new Map<string, Bucketed[]>()
	const bucketSeen = new Map<string, number>()

	async function* rowStreams(): AsyncGenerator<Record<string, string | undefined>> {
		if (values.zip) {
			yield* csvRecordsFromZip(values.zip, values.entry!)
		} else {
			for (const path of globSync(values["csv-glob"]!).sort()) {
				yield* csvRecordsFromFile(path)
			}
		}
	}

	let total = 0
	let done = false

	for await (const row of rowStreams()) {
		if (done) break
		const num = (row.NUMBER ?? "").trim()
		const street = (row.STREET ?? "").trim()
		const city = (row.CITY ?? "").trim()
		const cp = (row.POSTCODE ?? "").trim()
		const region = (row.REGION ?? "").trim()
		const lat = pyFloat(row.LAT)
		const lon = pyFloat(row.LON)

		if (lat === null || lon === null) continue

		if (!(num && street && city && cp && num !== "0" && /^\p{L}/u.test(street))) continue
		const key = region || cp.slice(0, 2) // geographic diversity bucket
		let bucket = buckets.get(key)

		if (!bucket) {
			bucket = []
			buckets.set(key, bucket)
		}

		if (reservoir) {
			// Algorithm R per bucket: every valid row in the stream has an equal chance of a slot.
			const seen = (bucketSeen.get(key) ?? 0) + 1
			bucketSeen.set(key, seen)

			if (bucket.length < perBucket) {
				bucket.push({ street: titlecaseIfUpper(street), num, cp, city: titlecaseIfUpper(city), lat, lon })
			} else {
				const j = rng.randint(0, seen - 1)

				if (j < perBucket) {
					bucket[j] = { street: titlecaseIfUpper(street), num, cp, city: titlecaseIfUpper(city), lat, lon }
				}
			}
		} else {
			if (bucket.length < perBucket) {
				bucket.push({ street: titlecaseIfUpper(street), num, cp, city: titlecaseIfUpper(city), lat, lon })
				total += 1
			}

			if (total >= n * 2) {
				done = true
			}
		}
	}

	const rows: Record<string, unknown>[] = []
	let i = 0

	for (const key of [...buckets.keys()].sort()) {
		for (const r of buckets.get(key)!) {
			const order = ORDERS[i % 3]!
			i += 1
			rows.push({
				raw: render(r.street, r.num, r.cp, r.city, order),
				components: { house_number: r.num, street: r.street, postcode: r.cp, locality: r.city },
				country: country.toUpperCase(),
				lat: r.lat,
				lon: r.lon,
				source: "golden",
			})
		}
	}
	rng.shuffle(rows)
	const trimmed = rows.slice(0, n)

	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, trimmed.map((r) => pyJsonDumps(r, { ensureAscii: false }) + "\n").join(""))
	process.stderr.write(
		`wrote ${trimmed.length} ${country.toUpperCase()} rows across ${buckets.size} buckets -> ${out}\n`
	)
}

await main()
