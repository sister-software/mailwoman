/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a coordinate-containing held-out eval set for a non-US locale from a standard-schema
 *   OpenAddresses country dump.
 *
 *   Label-F1 on non-US is confounded by labeling convention, since where a Spanish "Calle Mayor"
 *   street boundary falls is a judgement. These rows therefore include the truth lat/lon and are graded
 *   on the assembled coordinate by
 *   `packages/mailwoman/lib/dev-tools/fr/admin/split/eval.run.ts --default-country <CC>`.
 *
 *   Expects a countrywide CSV with `LON,LAT,number,street,city,postcode[,region]` (IT/FR/most OA
 *   collections). The Spanish dump uses a cadastral schema and is not handled here.
 *
 *   Rows are bucketed by region, or by the postcode's first two characters when region is absent, so
 *   the set spans the country. They are rendered in three natural orders so the model does not see one
 *   rigid template.
 *
 *   The seeded shuffle matches the Python original in distribution. It is not bit-identical to CPython
 *   (see `python-random.ts`), so a set rebuilt here will not match one built by the retired script
 *   row for row.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/build/oa-coord-golden.run.ts --country IT
 *   --zip $MAILWOMAN_DATA_ROOT/oa-cache/it__countrywide.zip
 *   --entry it/countrywide.csv --out data/eval/external/oa-it-coord-150.jsonl --n 150
 */

// oxlint-disable max-depth -- the streaming source-format state machine is intentionally kept in one pass

import { openReadStream } from "@mailwoman/core/fs/streams"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { pyFloat } from "@mailwoman/core/numeric"
import { SeededRandom } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { pyJSONDumps } from "@mailwoman/core/utils"
import { dirname } from "path-ts"
import { titleCaseIfUpper, CSVSpliterator, type CSVSpliteratorInit } from "spliterator"
import { Globerator } from "spliterator/node/fs"

/**
 * Approximates Python's default `csv.DictReader` dialect.
 *
 * `normalizeKeys: false` keeps the source's own header spelling.
 * The row reader indexes by that spelling because OpenAddresses ships all-caps headers.
 */
const CSV_OPTIONS = {
	normalizeKeys: false,
} satisfies CSVSpliteratorInit

type CSVRecord = Record<string, string | undefined>

function csvRecordsFromZip(zipPath: string, entry: string): AsyncIterable<CSVRecord> {
	return CSVSpliterator.fromAsync<CSVRecord>(readZipEntry(zipPath, entry), CSV_OPTIONS)
}

function csvRecordsFromFile(filePath: string): AsyncIterable<CSVRecord> {
	return CSVSpliterator.fromAsync<CSVRecord>(openReadStream(filePath), CSV_OPTIONS)
}

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
 * The street must open with a letter, since OA rows whose street is a bare number
 * or a lone punctuation mark are parse noise.
 * House number `"0"` is the dump's placeholder for "no number known".
 */
function parseRow(row: CSVRecord): Address | null {
	const num = row.NUMBER ?? ""
	const street = row.STREET ?? ""
	const city = row.CITY ?? ""
	const cp = row.POSTCODE ?? ""
	const lat = pyFloat(row.LAT)
	const lon = pyFloat(row.LON)

	if (lat === null || lon === null) return null

	if (!num || !street || !city || !cp || num === "0" || !/^\p{L}/u.test(street)) return null

	return { street: titleCaseIfUpper(street), num, cp, city: titleCaseIfUpper(city), lat, lon }
}

/**
 * Geographic diversity key: the region when the dump includes one, else the postcode's leading pair.
 */
function bucketKey(row: CSVRecord, address: Address): string {
	return (row.REGION ?? "") || address.cp.slice(0, 2)
}

interface SampleOptions {
	perBucket: number
	/**
	 * Stop once this many rows are held.
	 *
	 * Ignored in reservoir mode.
	 * That mode must see the whole stream.
	 */
	target: number
	/**
	 * Sample each bucket uniformly across the whole stream.
	 *
	 * The default fill takes a bucket's rows from wherever its key first appears in file order,
	 * so municipality-ordered dumps (OA CZ/PL) concentrate every bucket on one city
	 * and under-disperse the localities the wrong-city metric needs.
	 *
	 * Reservoir mode costs a full pass.
	 * Selection stays deterministic per seed and input order.
	 */
	reservoir: boolean
	rng: SeededRandom
}

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
 * Flatten the buckets into eval rows, cycling the render order across the whole set
 * so no region is rendered in one shape.
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

async function* sourceRows(): AsyncIterable<CSVRecord> {
	if (values.zip) {
		yield* csvRecordsFromZip(values.zip, values.entry!)

		return
	}

	const pattern = values["csv-glob"]!
	const filePaths = await Globerator.from(pattern, { absolute: true }).toSorted()

	for (const filePath of filePaths) {
		yield* csvRecordsFromFile(filePath)
	}
}

const buckets = await collectBuckets(sourceRows(), {
	perBucket: Number(values["per-bucket"]),
	// Twice the target, so the shuffle has slack to draw a spread from.
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
