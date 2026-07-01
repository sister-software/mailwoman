/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reservoir-sample an OpenAddresses national CSV (inside a ZIP64 zip) into a resolver-eval JSONL.
 *
 *   The ingest-openaddresses.mjs path uses `unzip -p`, which historically choked on ZIP64 (national
 *   datasets like FR BAN have a >4GB CSV); Debian's UnZip 6.00 has large-file support, and we
 *   stream the member through `csv-parse` (see scripts/lib/zip-csv.ts). Same output shape as the
 *   other openaddresses-*-sample.jsonl files: {input, lat, lon,
 *   expected:{locality,region,postcode}, state, source}.
 *
 *   Usage: node --experimental-strip-types scripts/eval/sample-oa-zip.ts --zip
 *   /tmp/oa-cache/fr__countrywide.zip\
 *   --country FR --target 3000 --seed 42 --out data/eval/external/openaddresses-fr-sample.jsonl
 *
 *   Ported faithfully from scripts/eval/sample-oa-zip.py. NOTE: the seeded reservoir RNG is
 *   distribution-faithful but NOT CPython-bit-identical (see python-random.ts); the algorithm,
 *   filters, and schema are preserved.
 */

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { pyJsonDumps } from "../lib/python-json.ts"
import { SeededRandom } from "../lib/python-random.ts"
import { csvRecordsFromZip, firstCSVEntry } from "../lib/zip-csv.ts"

type Row = Record<string, string | undefined>

const BBOX: Record<string, [number, number, number, number]> = {
	FR: [41.0, 51.5, -5.5, 9.7],
	NL: [50.7, 53.6, 3.3, 7.3],
	IT: [35.0, 47.2, 6.5, 18.6],
	ES: [27.5, 43.9, -18.3, 4.4], // mainland + Balearics + Canaries
}

// Normalize a raw CSV row to the OA-standard column names. Most national OA exports already use
// NUMBER/STREET/CITY/POSTCODE/REGION/LAT/LON; Spain ships the CartoCiudad schema (X/Y, nombre_via,
// poblacion, provincia, …) so we remap it. STREET folds in the Spanish street-type (CALLE/AVENIDA).
function normalizeRow(country: string, r: Row): Row {
	if (country === "ES") {
		const via = `${(r.tipo_vial ?? "").trim()} ${(r.nombre_via ?? "").trim()}`.trim()

		return {
			LAT: r.Y,
			LON: r.X,
			NUMBER: (r.numero ?? "").trim(),
			STREET: via,
			CITY: (r.poblacion ?? "").trim(),
			POSTCODE: (r.cod_postal ?? "").trim(),
			REGION: (r.provincia ?? "").trim(),
		}
	}

	return r
}

/** Python `str.strip(", ")` — strip leading/trailing chars that are comma or space. */
function stripCommaSpace(s: string): string {
	return s.replace(/^[, ]+/, "").replace(/[, ]+$/, "")
}

// Render order per locale (the raw string the parser sees).
function render(country: string, r: Row): string {
	const num = (r.NUMBER ?? "").trim()
	const street = (r.STREET ?? "").trim()
	const pc = (r.POSTCODE ?? "").trim()
	const city = (r.CITY ?? "").trim()

	if (country === "FR") return stripCommaSpace(`${num} ${street}, ${pc} ${city}`)

	// "12 Rue de Rivoli, 75001 Paris"
	// number after street: "Via Roma 12, 20121 Milano" / "Calle de Alcalá 1, 28014 Madrid"
	if (country === "NL" || country === "IT" || country === "ES")
		return stripCommaSpace(`${street} ${num}, ${pc} ${city}`)

	return `${num} ${street}, ${pc} ${city}`
}

/**
 * Python `float(s)`: empty/non-numeric -> null (covers the ValueError/KeyError/TypeError -> continue).
 */
function pyFloat(s: string | undefined): number | null {
	if (s == null) return null
	const t = s.trim()

	if (t === "") return null
	const v = Number(t)

	return Number.isNaN(v) ? null : v
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			zip: { type: "string" },
			country: { type: "string" },
			target: { type: "string", default: "3000" },
			seed: { type: "string", default: "42" },
			out: { type: "string" },
		},
	})

	for (const req of ["zip", "country", "out"] as const) {
		if (!values[req]) {
			process.stderr.write(`error: the following arguments are required: --${req}\n`)
			process.exit(2)
		}
	}
	const zip = values.zip!
	const country = values.country!
	const target = Number(values.target)
	const out = values.out!

	const rng = new SeededRandom(Number(values.seed))
	const bbox = BBOX[country]

	if (!bbox) throw new Error(`no bbox for country ${country}`)
	const [minlat, maxlat, minlon, maxlon] = bbox

	const csvName = firstCSVEntry(zip)
	const reservoir: Record<string, unknown>[] = []
	let seen = 0

	for await (const rawRow of csvRecordsFromZip(zip, csvName)) {
		const r = normalizeRow(country, rawRow)
		const lat = pyFloat(r.LAT)
		const lon = pyFloat(r.LON)

		if (lat === null || lon === null) continue

		if (!(minlat! <= lat && lat <= maxlat! && minlon! <= lon && lon <= maxlon!)) continue
		const city = (r.CITY ?? "").trim()
		const pc = (r.POSTCODE ?? "").trim()

		if (!city || !pc) continue // admin-level eval needs city + postcode
		seen += 1
		const region = (r.REGION ?? "").trim() || null
		const row = {
			input: render(country, r),
			lat,
			lon,
			expected: { locality: city, region, postcode: pc },
			state: country,
			source: `openaddresses:${country.toLowerCase()}/countrywide`,
		}

		if (reservoir.length < target) {
			reservoir.push(row)
		} else {
			const j = rng.randint(0, seen - 1)

			if (j < target) reservoir[j] = row
		}
	}

	writeFileSync(out, reservoir.map((row) => pyJsonDumps(row, { ensureAscii: false }) + "\n").join(""))
	console.log(`wrote ${reservoir.length} rows (sampled from ${seen.toLocaleString("en-US")} valid in-bbox) → ${out}`)
}

await main()
