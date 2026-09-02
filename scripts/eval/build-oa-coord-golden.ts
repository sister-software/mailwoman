/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a coordinate-bearing held-out eval set for a non-US locale from a standard-schema
 *   OpenAddresses country dump (#229 Phase A).
 *
 *   Label-F1 on non-US is confounded by labeling convention — where a Spanish "Calle Mayor" street
 *   boundary falls is a judgement, not a fact — so these rows carry the truth lat/lon and are graded
 *   on the ASSEMBLED COORDINATE by `scripts/eval/fr-admin-split-eval.ts --default-country <CC>`.
 *
 *   Expects a countrywide CSV with `LON,LAT,NUMBER,STREET,CITY,POSTCODE[,REGION]` (IT/FR/most OA
 *   collections). The Spanish dump uses a cadastral schema and is not handled here.
 *
 *   Rows are bucketed by REGION — or the postcode's first two characters when REGION is absent — so
 *   the set spans the country rather than whichever province leads the file, and rendered in three
 *   natural orders so the model is not graded against one rigid template.
 *
 *   The seeded shuffle is distribution-faithful to the Python original but NOT CPython-bit-identical
 *   (see `python-random.ts`), so a set rebuilt here will not match one built by the retired script
 *   row for row.
 *
 *   Usage: node scripts/eval/build-oa-coord-golden.ts --country IT
 *   --zip $MAILWOMAN_DATA_ROOT/oa-cache/it__countrywide.zip
 *   --entry it/countrywide.csv --out data/eval/external/oa-it-coord-150.jsonl --n 150
 */

// oxlint-disable max-depth -- the streaming source-format state machine is intentionally kept in one pass

import { titlecaseIfUpper } from "@mailwoman/core"
import { globPaths } from "@mailwoman/core/fs/readers"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { pyFloat } from "@mailwoman/core/numeric"
import { SeededRandom } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { pyJSONDumps } from "@mailwoman/core/utils"
import { dirname } from "path-ts"
import { CSVSpliterator, type CSVSpliteratorInit } from "spliterator"

//#region CSV source

/**
 * Approximates Python's default `csv.DictReader` dialect.
 *
 * `normalizeKeys: false` keeps the source's own header spelling, which is what the row reader indexes by —
 * OpenAddresses ships ALL-CAPS headers. Quote handling is ON because OA street and city fields wrap embedded commas,
 * and the spliterator leaves it off by default.
 */
const CSV_OPTIONS = {
	mode: "object",
	normalizeKeys: false,
	enableQuoteHandling: true,
} satisfies CSVSpliteratorInit

type CSVRecord = Record<string, string | undefined>

/**
 * Drop a leading UTF-8 BOM.
 *
 * The spliterator has no BOM option, and a BOM survives into the FIRST HEADER NAME — `\uFEFFLON` rather than `LON` — so
 * every row reads that one column as absent while the rest parse cleanly.
 */
async function* withoutBOM(source: AsyncIterable<Uint8Array | string>): AsyncIterable<Uint8Array> {
	let first = true

	for await (const chunk of source) {
		let bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk

		if (first) {
			first = false

			if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
				bytes = bytes.subarray(3)
			}
		}

		yield bytes
	}
}

/**
 * Stream header-keyed records from one member of an archive.
 */
async function* csvRecordsFromZip(zipPath: string, entry: string): AsyncGenerator<CSVRecord> {
	yield* CSVSpliterator.fromAsync<CSVRecord>(withoutBOM(readZipEntry(zipPath, entry)), CSV_OPTIONS)
}

async function* csvRecordsFromFile(path: string): AsyncGenerator<CSVRecord> {
	yield* CSVSpliterator.fromAsync<CSVRecord>(withoutBOM(openReadStream(path)), CSV_OPTIONS)
}

//#endregion

//#region Sampling

/**
 * The address orders a row can be rendered in, cycled so no single template dominates the set.
 */
const ORDERS = ["canonical", "pc-first", "city-first"] as const

type Order = (typeof ORDERS)[number]

interface Address {
	street: string
	num: string
	cp: string
	city: string
	lat: number
	lon: number
}

/**
 * A usable address, or `null` for a row missing a field the eval needs.
 *
 * The street must OPEN with a letter: OA rows whose STREET is a bare number or a lone punctuation mark are parse noise,
 * not addresses. House number `"0"` is the dump's placeholder for "no number known".
 */
function parseRow(row: CSVRecord): Address | null {
	const num = (row.NUMBER ?? "").trim()
	const street = (row.STREET ?? "").trim()
	const city = (row.CITY ?? "").trim()
	const cp = (row.POSTCODE ?? "").trim()
	const lat = pyFloat(row.LAT)
	const lon = pyFloat(row.LON)

	if (lat === null || lon === null) return null

	if (!num || !street || !city || !cp || num === "0" || !/^\p{L}/u.test(street)) return null

	return { street: titlecaseIfUpper(street), num, cp, city: titlecaseIfUpper(city), lat, lon }
}

/**
 * Geographic diversity key: the region when the dump carries one, else the postcode's leading pair.
 */
function bucketKey(row: CSVRecord, address: Address): string {
	return (row.REGION ?? "").trim() || address.cp.slice(0, 2)
}

interface SampleOptions {
	perBucket: number
	/**
	 * Stop once this many rows are held. Ignored in reservoir mode, which has to see the whole stream.
	 */
	target: number
	/**
	 * Sample each bucket uniformly across the WHOLE stream rather than taking its first `perBucket` rows.
	 *
	 * The default fill takes a bucket's rows from wherever its key first appears in file order. Municipality-ordered
	 * dumps (OA CZ/PL) therefore concentrate every bucket on one city, which under-disperses the localities the
	 * wrong-city metric needs (#291). Reservoir mode costs a full pass; selection stays deterministic per seed and input
	 * order.
	 */
	reservoir: boolean
	rng: SeededRandom
}

/**
 * Bucket the stream, capping each bucket at `perBucket`.
 */
async function collectBuckets(rows: AsyncIterable<CSVRecord>, opts: SampleOptions): Promise<Map<string, Address[]>> {
	const buckets = new Map<string, Address[]>()
	const seenPerBucket = new Map<string, number>()
	let held = 0

	for await (const row of rows) {
		const address = parseRow(row)

		if (!address) continue

		const key = bucketKey(row, address)
		let bucket = buckets.get(key)

		if (!bucket) {
			bucket = []
			buckets.set(key, bucket)
		}

		if (!opts.reservoir) {
			if (bucket.length < opts.perBucket) {
				bucket.push(address)

				held++
			}

			if (held >= opts.target) break

			continue
		}

		// Algorithm R: every valid row in the bucket has an equal chance of holding a slot.
		const seen = (seenPerBucket.get(key) ?? 0) + 1

		seenPerBucket.set(key, seen)

		if (bucket.length < opts.perBucket) {
			bucket.push(address)

			continue
		}

		const slot = opts.rng.randint(0, seen - 1)

		if (slot < opts.perBucket) {
			bucket[slot] = address
		}
	}

	return buckets
}

function render(a: Address, order: Order): string {
	if (order === "canonical") return `${a.street} ${a.num}, ${a.cp} ${a.city}`

	if (order === "pc-first") return `${a.cp} ${a.city}, ${a.street} ${a.num}`

	return `${a.city}, ${a.cp}, ${a.street} ${a.num}`
}

/**
 * Flatten the buckets into eval rows, cycling the render order across the whole set rather than within a bucket, so no
 * region is rendered in one shape.
 */
function toEvalRows(buckets: Map<string, Address[]>, country: string): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = []

	for (const key of [...buckets.keys()].toSorted()) {
		for (const address of buckets.get(key)!) {
			rows.push({
				raw: render(address, ORDERS[rows.length % ORDERS.length]!),
				components: {
					house_number: address.num,
					street: address.street,
					postcode: address.cp,
					locality: address.city,
				},
				country: country.toUpperCase(),
				lat: address.lat,
				lon: address.lon,
				source: "golden",
			})
		}
	}

	return rows
}

//#endregion

const { values } = parseArguments({
	options: {
		country: { type: "string" },
		zip: { type: "string" },
		entry: { type: "string" },
		"csv-glob": { type: "string" },
		out: { type: "string" },
		n: { type: "string", default: "150" },
		"per-bucket": { type: "string", default: "8" },
		seed: { type: "string", default: "722" },
		reservoir: { type: "boolean", default: false },
	},
})

for (const required of ["country", "out"] as const) {
	if (!values[required]) {
		process.stderr.write(`error: the following arguments are required: --${required}\n`)
		process.exit(2)
	}
}

const country = values.country!
const out = values.out!
const n = Number(values.n)
const rng = new SeededRandom(Number(values.seed))

async function* sourceRows(): AsyncGenerator<CSVRecord> {
	if (values.zip) {
		yield* csvRecordsFromZip(values.zip, values.entry!)

		return
	}

	for (const path of await globPaths(values["csv-glob"]!)) {
		yield* csvRecordsFromFile(path)
	}
}

const buckets = await collectBuckets(sourceRows(), {
	perBucket: Number(values["per-bucket"]),
	// Twice the target, so the shuffle has slack to draw a spread from rather than emitting the first n.
	target: n * 2,
	reservoir: values.reservoir,
	rng,
})

const rows = toEvalRows(buckets, country)

rng.shuffle(rows)

const trimmed = rows.slice(0, n)

await makeDirectories(dirname(out))
await writeLocalTextFile(trimmed.map((row) => pyJSONDumps(row, { ensureASCII: false }) + "\n").join(""), out)

process.stderr.write(`wrote ${trimmed.length} ${country.toUpperCase()} rows across ${buckets.size} buckets -> ${out}\n`)
