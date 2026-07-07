/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Extract (locality, region, postcode, country) tuples from existing parquet corpus shards.
 *
 *   Reads a parquet shard, scans the BIO labels for rows that have at least (locality + region +
 *   postcode), reconstructs the component spans from tokens+labels, and writes a JSONL file with
 *   one tuple per output line. Also emits street + houseNumber if present (used for PMB
 *   synthesis).
 *
 *   Ported faithfully from scripts/extract-tuples.py. Parquet reads go through DuckDB
 *   (`@duckdb/node-api`); the WOF SQLite path uses `node:sqlite`.
 *
 *   Usage: node --experimental-strip-types scripts/extract-tuples.ts\
 *   --shards /mnt/playpen/mailwoman-data/wof/admin-global-priority.db\
 *   --output /tmp/tuples.jsonl\
 *   [--limit 50000]
 */

import { closeSync, openSync, writeSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DuckDBInstance } from "@duckdb/node-api"
import { SeededRandom } from "@mailwoman/core/utils"

/** A sink that appends a chunk of text to the output file. */
type WriteFn = (chunk: string) => void

/** Coerce a DuckDB list column (a `DuckDBListValue` with `.items`, or a plain array) to `string[]`. */
function toStringArray(value: unknown): string[] {
	if (value == null) return []

	if (Array.isArray(value)) return value.map((v) => String(v))
	const items = (value as { items?: unknown[] }).items

	if (Array.isArray(items)) return items.map((v) => String(v))

	return []
}

/**
 * True when `s` contains at least one Unicode letter or number (Python `c.isdigit() or c.isalpha()`).
 */
function hasAlnum(s: string): boolean {
	return /[\p{L}\p{N}]/u.test(s)
}

/** Pull (locality, region, postcode, country, [street, houseNumber]) from a parquet shard. */
async function extractFromParquet(shardPath: string, write: WriteFn, limit: number | undefined): Promise<number> {
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()
	const escaped = shardPath.replace(/'/g, "''")
	const result = await db.runAndReadAll(`SELECT tokens, labels, country FROM read_parquet('${escaped}')`)
	const rows = result.getRowObjects() as Array<Record<string, unknown>>

	let emitted = 0

	for (const row of rows) {
		if (limit != null && emitted >= limit) break

		const tokens = toStringArray(row.tokens)
		const labels = toStringArray(row.labels)
		const country = (row.country as string | null) || "US"

		if (tokens.length === 0 || labels.length === 0) continue

		// Group tokens by component tag (B-tag starts new span; I-tag continues).
		const components: Record<string, string[]> = {}
		let currentTag: string | null = null
		const n = Math.min(tokens.length, labels.length)

		for (let i = 0; i < n; i++) {
			const tok = tokens[i]!
			const lab = labels[i]!

			if (lab === "O") {
				currentTag = null
				continue
			}
			const dash = lab.indexOf("-")
			const prefix = dash >= 0 ? lab.slice(0, dash) : lab
			const tag = dash >= 0 ? lab.slice(dash + 1) : ""

			if (prefix === "B" || tag !== currentTag) {
				if (!(tag in components)) {
					components[tag] = []
				}
				components[tag]!.push(tok)
				currentTag = tag
			} else {
				const arr = components[tag]!
				arr[arr.length - 1] += " " + tok
				currentTag = tag
			}
		}

		// Need at least locality + region + postcode.
		const loc = components.locality ? components.locality[0] : undefined
		const reg = components.region ? components.region[0] : undefined
		const pc = components.postcode ? components.postcode[0] : undefined

		if (!loc || !reg || !pc) continue

		// Drop any rows whose postcode is bogus (test-data hallucinations).
		if (pc.length < 3 || !hasAlnum(pc)) continue

		const tupleOut: Record<string, string> = {
			locality: loc,
			region: reg,
			postcode: pc,
			country,
		}
		const street = components.street ? components.street[0] : undefined
		const hn = components.house_number ? components.house_number[0] : undefined

		if (street) {
			tupleOut.street = street
		}

		if (hn) {
			tupleOut.houseNumber = hn
		}

		write(JSON.stringify(tupleOut) + "\n")
		emitted++
	}

	return emitted
}

/**
 * Pull tuples directly from the WOF SQLite admin DB.
 *
 * For US: pair localities with sampled US postcodes (we don't have the postalcode WOF repo locally yet). For now,
 * synthesize plausible 5-digit postcodes from the parent state's known ZIP range. This is acceptable because the model
 * trains on the SHAPE, not on geocoder-correctness of locality↔postcode pairs.
 */
function extractFromSqlite(dbPath: string, write: WriteFn, limit: number | undefined): number {
	// State ZIP code first-digit ranges. Approximate, not exhaustive.
	const STATE_ZIP_PREFIXES: Record<string, [number, number]> = {
		AL: [350, 369],
		AK: [995, 999],
		AZ: [850, 865],
		AR: [716, 729],
		CA: [900, 961],
		CO: [800, 816],
		CT: [60, 69],
		DE: [197, 199],
		FL: [320, 349],
		GA: [300, 319],
		HI: [967, 968],
		ID: [832, 838],
		IL: [600, 629],
		IN: [460, 479],
		IA: [500, 528],
		KS: [660, 679],
		KY: [400, 427],
		LA: [700, 714],
		ME: [39, 49],
		MD: [206, 219],
		MA: [10, 27],
		MI: [480, 499],
		MN: [550, 567],
		MS: [386, 397],
		MO: [630, 658],
		MT: [590, 599],
		NE: [680, 693],
		NV: [889, 898],
		NH: [30, 38],
		NJ: [70, 89],
		NM: [870, 884],
		NY: [100, 149],
		NC: [270, 289],
		ND: [580, 588],
		OH: [430, 458],
		OK: [730, 749],
		OR: [970, 979],
		PA: [150, 196],
		RI: [28, 29],
		SC: [290, 299],
		SD: [570, 577],
		TN: [370, 385],
		TX: [750, 799],
		UT: [840, 847],
		VT: [50, 59],
		VA: [220, 246],
		WA: [980, 994],
		WV: [247, 268],
		WI: [530, 549],
		WY: [820, 831],
		DC: [200, 205],
	}

	// Coarse name → abbreviation lookup (used when the WOF region name is spelled out).
	const FROM_NAME: Record<string, string> = {
		Alabama: "AL",
		Alaska: "AK",
		Arizona: "AZ",
		Arkansas: "AR",
		California: "CA",
		Colorado: "CO",
		Connecticut: "CT",
		Delaware: "DE",
		Florida: "FL",
		Georgia: "GA",
		Hawaii: "HI",
		Idaho: "ID",
		Illinois: "IL",
		Indiana: "IN",
		Iowa: "IA",
		Kansas: "KS",
		Kentucky: "KY",
		Louisiana: "LA",
		Maine: "ME",
		Maryland: "MD",
		Massachusetts: "MA",
		Michigan: "MI",
		Minnesota: "MN",
		Mississippi: "MS",
		Missouri: "MO",
		Montana: "MT",
		Nebraska: "NE",
		Nevada: "NV",
		"New Hampshire": "NH",
		"New Jersey": "NJ",
		"New Mexico": "NM",
		"New York": "NY",
		"North Carolina": "NC",
		"North Dakota": "ND",
		Ohio: "OH",
		Oklahoma: "OK",
		Oregon: "OR",
		Pennsylvania: "PA",
		"Rhode Island": "RI",
		"South Carolina": "SC",
		"South Dakota": "SD",
		Tennessee: "TN",
		Texas: "TX",
		Utah: "UT",
		Vermont: "VT",
		Virginia: "VA",
		Washington: "WA",
		"West Virginia": "WV",
		Wisconsin: "WI",
		Wyoming: "WY",
		"District of Columbia": "DC",
	}

	const rng = new SeededRandom(42)

	const conn = new DatabaseSync(dbPath, { readOnly: true })

	// Get US localities with their grandparent region. WOF hierarchy is
	// locality → county → region → country.
	const stmt = conn.prepare(`
		SELECT s.name as locality, r.name as region_name
		FROM spr s
		JOIN spr c ON s.parent_id = c.id AND c.placetype = 'county'
		JOIN spr r ON c.parent_id = r.id AND r.placetype = 'region'
		WHERE s.country = 'US' AND s.placetype = 'locality' AND s.is_current = 1
		ORDER BY RANDOM()
		LIMIT ?
	`)

	let emitted = 0

	for (const r of stmt.iterate(limit != null ? limit : 100000)) {
		const row = r as { locality: string | null; region_name: string | null }
		const locality = row.locality
		const regionName = row.region_name

		if (!locality || !regionName) continue

		// Best-effort: convert "California" → "CA". If region_name is already an abbrev, use as-is.
		let abbr: string | undefined

		if (regionName.length === 2 && regionName.toUpperCase() in STATE_ZIP_PREFIXES) {
			abbr = regionName.toUpperCase()
		} else {
			abbr = FROM_NAME[regionName]
		}

		if (!abbr || !(abbr in STATE_ZIP_PREFIXES)) continue

		const [lo, hi] = STATE_ZIP_PREFIXES[abbr]!
		// Random 5-digit ZIP within the state's range.
		const prefix = lo + Math.trunc(rng.random() * (hi - lo + 1))
		const zip5 = `${String(prefix).padStart(3, "0")}${String(rng.randint(0, 99)).padStart(2, "0")}`

		write(
			JSON.stringify({
				locality,
				region: abbr,
				postcode: zip5,
				country: "US",
			}) + "\n"
		)
		emitted++
	}

	conn.close()

	return emitted
}

interface Args {
	shards: string[]
	sqlite?: string
	output?: string
	limit?: number
}

function parseArgs(): Args {
	const argv = process.argv.slice(2)
	const shards: string[] = []
	let sqlite: string | undefined
	let output: string | undefined
	let limit: number | undefined

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]

		if (a === "--shards") {
			// argparse nargs="*": greedily consume following non-flag tokens.
			while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
				shards.push(argv[++i]!)
			}
		} else if (a === "--sqlite") {
			sqlite = argv[++i]
		} else if (a === "--output") {
			output = argv[++i]
		} else if (a === "--limit") {
			limit = parseInt(argv[++i]!, 10)
		}
	}

	return { shards, sqlite, output, limit }
}

async function main(): Promise<number> {
	const args = parseArgs()

	if (!args.output) {
		console.error("error: the following arguments are required: --output")
		process.exit(2)
	}

	const fd = openSync(args.output, "w")
	const write: WriteFn = (chunk) => {
		writeSync(fd, chunk)
	}

	let total = 0

	try {
		for (const shard of args.shards) {
			console.error(`  reading ${shard}...`)
			total += await extractFromParquet(shard, write, args.limit)
		}

		if (args.sqlite) {
			console.error(`  reading ${args.sqlite}...`)
			total += extractFromSqlite(args.sqlite, write, args.limit)
		}
	} finally {
		closeSync(fd)
	}

	console.error(`Wrote ${total} tuples to ${args.output}`)

	return 0
}

if (import.meta.main) {
	process.exit(await main())
}
