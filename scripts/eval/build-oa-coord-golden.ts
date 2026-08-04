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
 *   on the ASSEMBLED COORDINATE by `scripts/eval/fr-admin-split-gate.ts --default-country <CC>`.
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

// oxlint-disable max-depth

import { createReadStream, globSync, mkdirSync, writeFileSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import { parseArgs } from "node:util"
import { createInflateRaw } from "node:zlib"

import { titlecaseIfUpper } from "@mailwoman/core"
import { pyFloat, pyJSONDumps, SeededRandom } from "@mailwoman/core/utils"
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
 * The spliterator has no BOM option, and a BOM survives into the FIRST HEADER NAME — `﻿LON` rather than `LON` — so
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

//#region ZIP entry reader

/*
 * Signatures, little-endian. `zlib` decompresses a DEFLATE stream but knows nothing of the ZIP container, so the
 * central directory has to be walked by hand to find where an entry's bytes start and how many there are.
 */
const EOCD_SIGNATURE = 0x06_05_4b_50
const ZIP64_LOCATOR_SIGNATURE = 0x07_06_4b_50
const ZIP64_EOCD_SIGNATURE = 0x06_06_4b_50
const CENTRAL_HEADER_SIGNATURE = 0x02_01_4b_50
const LOCAL_HEADER_SIGNATURE = 0x04_03_4b_50

/**
 * The value a 32-bit size or offset carries when the real one lives in the entry's ZIP64 extra field.
 */
const ZIP64_SENTINEL_32 = 0xff_ff_ff_ff
const ZIP64_SENTINEL_16 = 0xff_ff

/**
 * ZIP64 extra-field header id.
 */
const ZIP64_EXTRA_ID = 0x00_01

/**
 * DEFLATE. The only other method these dumps use is 0, stored.
 */
const METHOD_DEFLATE = 8

/**
 * Bytes to sweep for the end-of-central-directory record: its fixed part plus the largest possible trailing comment.
 */
const EOCD_SEARCH_WINDOW = 22 + 0xff_ff

interface ZipEntry {
	compressionMethod: number
	compressedSize: number
	localHeaderOffset: number
}

/**
 * Locate an entry by name in the central directory.
 *
 * Handles ZIP64 because the national dumps need it — a member above 4 GB (FR BAN) parks `0xFFFFFFFF` in the 32-bit size
 * and offset fields and puts the real 64-bit values in the entry's extra field.
 */
async function findZipEntry(handle: FileHandle, fileSize: number, entryName: string): Promise<ZipEntry> {
	const tailLength = Math.min(EOCD_SEARCH_WINDOW, fileSize)
	const tail = Buffer.alloc(tailLength)

	await handle.read(tail, 0, tailLength, fileSize - tailLength)

	let eocd = -1

	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
			eocd = i

			break
		}
	}

	if (eocd < 0) throw new Error(`not a zip archive (no end-of-central-directory record)`)

	let centralOffset = tail.readUInt32LE(eocd + 16)
	let centralSize = tail.readUInt32LE(eocd + 12)
	const entryCount = tail.readUInt16LE(eocd + 10)

	if (centralOffset === ZIP64_SENTINEL_32 || centralSize === ZIP64_SENTINEL_32 || entryCount === ZIP64_SENTINEL_16) {
		let locatorAt = -1

		for (let i = eocd - 20; i >= 0; i--) {
			if (tail.readUInt32LE(i) === ZIP64_LOCATOR_SIGNATURE) {
				locatorAt = i

				break
			}
		}

		if (locatorAt < 0) throw new Error("zip64 archive without an end-of-central-directory locator")

		const zip64At = Number(tail.readBigUInt64LE(locatorAt + 8))
		const zip64 = Buffer.alloc(56)

		await handle.read(zip64, 0, 56, zip64At)

		if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw new Error("zip64 end-of-central-directory not found")

		centralSize = Number(zip64.readBigUInt64LE(40))
		centralOffset = Number(zip64.readBigUInt64LE(48))
	}

	const central = Buffer.alloc(centralSize)

	await handle.read(central, 0, centralSize, centralOffset)

	for (let at = 0; at + 46 <= central.length && central.readUInt32LE(at) === CENTRAL_HEADER_SIGNATURE;) {
		const nameLength = central.readUInt16LE(at + 28)
		const extraLength = central.readUInt16LE(at + 30)
		const commentLength = central.readUInt16LE(at + 32)
		const name = central.toString("utf8", at + 46, at + 46 + nameLength)

		if (name === entryName) {
			const entry: ZipEntry = {
				compressionMethod: central.readUInt16LE(at + 10),
				compressedSize: central.readUInt32LE(at + 20),
				localHeaderOffset: central.readUInt32LE(at + 42),
			}

			// The 64-bit values, when the 32-bit slots are sentinels. Order in the extra field is fixed —
			// uncompressed, compressed, offset — but each is present only if ITS slot was a sentinel.
			if (entry.compressedSize === ZIP64_SENTINEL_32 || entry.localHeaderOffset === ZIP64_SENTINEL_32) {
				const extraStart = at + 46 + nameLength
				const uncompressedIsSentinel = central.readUInt32LE(at + 24) === ZIP64_SENTINEL_32

				for (let e = extraStart; e + 4 <= extraStart + extraLength;) {
					const id = central.readUInt16LE(e)
					const size = central.readUInt16LE(e + 2)

					if (id === ZIP64_EXTRA_ID) {
						let cursor = e + 4

						if (uncompressedIsSentinel) {
							cursor += 8
						}

						if (entry.compressedSize === ZIP64_SENTINEL_32) {
							entry.compressedSize = Number(central.readBigUInt64LE(cursor))
							cursor += 8
						}

						if (entry.localHeaderOffset === ZIP64_SENTINEL_32) {
							entry.localHeaderOffset = Number(central.readBigUInt64LE(cursor))
						}

						break
					}

					e += 4 + size
				}
			}

			return entry
		}

		at += 46 + nameLength + extraLength + commentLength
	}

	throw new Error(`entry ${entryName} not found in the archive`)
}

/**
 * Stream one entry's bytes, inflating when the entry is deflated.
 *
 * The local header repeats the name and extra-field lengths — and its extra field is frequently a different length from
 * the central directory's — so where the data starts can only be read from the local header itself.
 */
async function* zipEntryBytes(zipPath: string, entryName: string): AsyncIterable<Uint8Array> {
	const handle = await open(zipPath)

	try {
		const { size } = await handle.stat()
		const entry = await findZipEntry(handle, size, entryName)
		const local = Buffer.alloc(30)

		await handle.read(local, 0, 30, entry.localHeaderOffset)

		if (local.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) throw new Error(`bad local header for ${entryName}`)

		const dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)

		const compressed = handle.createReadStream({
			start: dataStart,
			end: dataStart + entry.compressedSize - 1,
			autoClose: false,
		})

		if (entry.compressionMethod !== METHOD_DEFLATE) {
			yield* compressed

			return
		}

		yield* compressed.pipe(createInflateRaw())
	} finally {
		await handle.close()
	}
}

//#endregion

/**
 * Stream header-keyed records from one member of a possibly-ZIP64 archive.
 */
async function* csvRecordsFromZip(zipPath: string, entry: string): AsyncGenerator<CSVRecord> {
	yield* CSVSpliterator.fromAsync<CSVRecord>(withoutBOM(zipEntryBytes(zipPath, entry)), CSV_OPTIONS)
}

async function* csvRecordsFromFile(path: string): AsyncGenerator<CSVRecord> {
	yield* CSVSpliterator.fromAsync<CSVRecord>(withoutBOM(createReadStream(path)), CSV_OPTIONS)
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

	for (const path of globSync(values["csv-glob"]!).toSorted()) {
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

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, trimmed.map((row) => pyJSONDumps(row, { ensureASCII: false }) + "\n").join(""))

process.stderr.write(`wrote ${trimmed.length} ${country.toUpperCase()} rows across ${buckets.size} buckets -> ${out}\n`)
