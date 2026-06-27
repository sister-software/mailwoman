/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build ~150 diversified FR golden DEV rows sourced from real OA FR addresses. Addresses come from
 *   fr/countrywide.csv inside /tmp/oa-cache/fr__countrywide.zip (OpenAddresses data,
 *   https://openaddresses.io).
 *
 *   Each OA record provides NUMBER + STREET + POSTCODE + CITY — all from a real authoritative address
 *   registry (BAN: Base Adresse Nationale). We do NOT hand-invent streets or postcodes; we only
 *   choose the rendering ORDER.
 *
 *   Three canonical FR address orders are exercised: canonical : "NN Street, PPPPP City" (BAN /
 *   official mail order) pc-first : "PPPPP City, NN Street" (reversed — common in forms) city-pc-nn
 *   : "City, PPPPP, NN Street" (locality-first envelope style)
 *
 *   The street field in OA is already the full street name (e.g. "Rue de la Paix"), so
 *   components.street holds the full OA STREET value — matching the pattern used in the existing
 *   Sainte-Livrade BAN rows (not the hand-split prefix/particle form).
 *
 *   Usage: node --experimental-strip-types scripts/eval/build-fr-golden-diversified.ts writes
 *   data/eval/golden/v0.1.2/dev/fr-diversified.jsonl (preview) then you manually merge into
 *   fr.jsonl
 *
 *   Or: node --experimental-strip-types scripts/eval/build-fr-golden-diversified.ts --inplace appends
 *   directly to data/eval/golden/v0.1.2/dev/fr.jsonl
 *
 *   Ported faithfully from scripts/eval/build-fr-golden-diversified.py. NOTE: the seeded RNG
 *   (sample/shuffle) is distribution-faithful but NOT CPython-bit-identical (see python-random.ts);
 *   the original's preferred-city ordering was already PYTHONHASHSEED-dependent, so exact rows were
 *   never reproducible. Logic, filters, and schema are preserved.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { pyJsonDumps } from "../lib/python-json.ts"
import { SeededRandom } from "../lib/python-random.ts"
import { csvRecordsFromZip } from "../lib/zip-csv.ts"

const OA_ZIP = "/tmp/oa-cache/fr__countrywide.zip"
const OA_ENTRY = "fr/countrywide.csv"
const OUT_FILE = "data/eval/golden/v0.1.2/dev/fr-diversified.jsonl"
const GOLDEN_FILE = "data/eval/golden/v0.1.2/dev/fr.jsonl"

// How many source cities to sample from
const TARGET_ROWS = 150
const CITIES_PER_BATCH = 50 // sample from this many distinct cities
const ROWS_PER_CITY = 3 // max OA rows to use per city

// Seed for reproducibility
const RNG_SEED = 466

// Prefer these well-known cities (will always be included if found)
const PREFERRED_CITIES = new Set([
	"Paris",
	"Marseille",
	"Lyon",
	"Toulouse",
	"Bordeaux",
	"Nantes",
	"Strasbourg",
	"Montpellier",
	"Rennes",
	"Reims",
	"Le Havre",
	"Grenoble",
	"Dijon",
	"Angers",
	"Nîmes",
	"Toulon",
	"Clermont-Ferrand",
	"Amiens",
	"Limoges",
	"Perpignan",
	"Brest",
	"Caen",
	"Metz",
	"Nancy",
	"Orléans",
	"Rouen",
	"Mulhouse",
	"Dunkerque",
	"Avignon",
	"Nice",
	"Versailles",
])

// These are the three rendering orders
const ORDERS = ["canonical", "pc-first", "city-pc-nn"]

interface OaAddr {
	number: string
	street: string
	postcode: string
	city: string
}

/** Read OA zip and collect up to ROWS_PER_CITY samples per city. */
async function loadOaSamples(): Promise<Map<string, OaAddr[]>> {
	const cityPool = new Map<string, OaAddr[]>()

	process.stderr.write(`Opening ${OA_ZIP} ...\n`)
	let scanned = 0
	outer: for await (const row of csvRecordsFromZip(OA_ZIP, OA_ENTRY)) {
		const city = (row.CITY ?? "").trim()
		const num = (row.NUMBER ?? "").trim()
		const street = (row.STREET ?? "").trim()
		const postcode = (row.POSTCODE ?? "").trim()

		// Basic quality filters
		if (!(city && num && street && postcode)) continue
		if (postcode.length !== 5 || !/^[0-9]+$/.test(postcode)) continue
		// Skip numbers like "5000" (no-geometry placeholder in BAN)
		const stripped = num.replace(/[A-Za-z]+$/, "")
		if (!/^[+-]?[0-9]+$/.test(stripped)) continue // Python int() ValueError -> continue
		if (parseInt(stripped, 10) >= 5000) continue

		let bucket = cityPool.get(city)
		if (!bucket) {
			bucket = []
			cityPool.set(city, bucket)
		}
		bucket.push({ number: num, street, postcode, city })

		scanned += 1
		if (scanned % 5_000_000 === 0) {
			process.stderr.write(
				`  scanned ${scanned.toLocaleString("en-US")} rows, ${cityPool.size.toLocaleString("en-US")} cities so far\n`
			)
		}
		// Stop after 20M rows — enough to cover all of France
		if (scanned >= 20_000_000) break outer
	}

	process.stderr.write(
		`Done: ${scanned.toLocaleString("en-US")} rows, ${cityPool.size.toLocaleString("en-US")} distinct cities\n`
	)
	return cityPool
}

/** Pick CITIES_PER_BATCH cities: preferred first, then random others. */
function selectCities(cityPool: Map<string, OaAddr[]>, rng: SeededRandom): string[] {
	const foundPreferred = [...PREFERRED_CITIES].filter((c) => cityPool.has(c))
	const remaining = [...cityPool.keys()].filter((c) => !PREFERRED_CITIES.has(c))
	rng.shuffle(remaining)
	// Combine: prefer famous cities but cap total at CITIES_PER_BATCH
	return [...foundPreferred, ...remaining].slice(0, CITIES_PER_BATCH)
}

/** Render one address row in the given order. */
function makeRow(num: string, street: string, postcode: string, city: string, order: string): Record<string, unknown> {
	const components: Record<string, string> = {
		house_number: num,
		street,
		postcode,
		locality: city,
	}

	let raw: string
	let note: string
	if (order === "canonical") {
		raw = `${num} ${street}, ${postcode} ${city}`
		note = "FR canonical order: house_number street, postcode locality (OA/BAN source)"
	} else if (order === "pc-first") {
		raw = `${postcode} ${city}, ${num} ${street}`
		note = "FR reversed order: postcode locality, house_number street (common in forms)"
	} else if (order === "city-pc-nn") {
		raw = `${city}, ${postcode}, ${num} ${street}`
		note = "FR locality-first style: locality, postcode, house_number street"
	} else {
		throw new Error(`Unknown order: ${order}`)
	}

	return { raw, components, country: "FR", source: "golden", notes: note }
}

function buildRows(cityPool: Map<string, OaAddr[]>, rng: SeededRandom): Record<string, unknown>[] {
	const cities = selectCities(cityPool, rng)
	const rows: Record<string, unknown>[] = []

	for (const city of cities) {
		const candidates = cityPool.get(city)!
		// Pick up to ROWS_PER_CITY distinct OA addresses
		const sampleSize = Math.min(ROWS_PER_CITY, candidates.length)
		const sampled = rng.sample(candidates, sampleSize)

		sampled.forEach((addr, i) => {
			// Cycle through orders so every city covers at least one distinct order
			const order = ORDERS[i % ORDERS.length]!
			rows.push(makeRow(addr.number, addr.street, addr.postcode, addr.city, order))
		})

		if (rows.length >= TARGET_ROWS) break
	}

	// Trim to target
	return rows.slice(0, TARGET_ROWS)
}

function reportDistribution(rows: Record<string, unknown>[]): void {
	const localityCounts = new Map<string, number>()
	const orderCounts = new Map<string, number>()

	for (const r of rows) {
		const loc = (r.components as Record<string, string>).locality ?? "?"
		localityCounts.set(loc, (localityCounts.get(loc) ?? 0) + 1)
		// Determine order from notes
		const note = (r.notes as string) ?? ""
		let order: string | null = null
		if (note.includes("canonical")) order = "canonical"
		else if (note.includes("reversed")) order = "pc-first"
		else if (note.includes("locality-first")) order = "city-pc-nn"
		if (order) orderCounts.set(order, (orderCounts.get(order) ?? 0) + 1)
	}

	console.log(`\n=== Distribution report (${rows.length} new rows) ===`)
	console.log(`\nOrder mix:`)
	for (const [order, count] of [...orderCounts.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${order}: ${count}`)
	}

	console.log(`\nTop localities (by count):`)
	for (const [loc, count] of [...localityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
		console.log(`  ${loc}: ${count}`)
	}

	console.log(`\nDistinct localities: ${localityCounts.size}`)
}

async function main(): Promise<void> {
	const inplace = process.argv.includes("--inplace")

	const rng = new SeededRandom(RNG_SEED)
	const cityPool = await loadOaSamples()
	const rows = buildRows(cityPool, rng)

	reportDistribution(rows)

	const dest = inplace ? GOLDEN_FILE : OUT_FILE
	if (inplace) process.stderr.write(`\nAppending ${rows.length} rows to ${dest} ...\n`)
	else process.stderr.write(`\nWriting ${rows.length} rows to ${dest} ...\n`)

	mkdirSync(dirname(dest), { recursive: true })
	const content = rows.map((row) => pyJsonDumps(row, { ensureAscii: false }) + "\n").join("")
	if (inplace) appendFileSync(dest, content)
	else writeFileSync(dest, content)

	process.stderr.write("Done.\n")

	// Validate JSON parse of every written line
	if (!inplace) {
		const lines = readFileSync(dest, "utf-8").split("\n")
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] === "" && i === lines.length - 1) continue // trailing newline
			try {
				JSON.parse(lines[i]!)
			} catch (e) {
				process.stderr.write(`JSON parse error at line ${i + 1}: ${(e as Error).message}\n`)
				process.exit(1)
			}
		}
		process.stderr.write(`All ${rows.length} lines parse clean.\n`)
	}
}

await main()
