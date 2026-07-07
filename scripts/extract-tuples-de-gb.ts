/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Extract (locality, region, postcode, country) tuples for DE + GB from the WOF admin SQLite DB,
 *   with synthetic plausible postcodes. Output: JSONL ready for
 *   `scripts/build-no-street-shard.mjs`.
 *
 *   This complements `extract-tuples.ts` (which is US-only on its SQLite path). The point of DE/GB
 *   tuples specifically is the bilingual no-street shard recommended by DeepSeek turn 7: a small
 *   amount of non-US anti-decompose signal that doesn't commit us to the full v0.7 locale-expansion
 *   scope.
 *
 *   Ported faithfully from scripts/extract-tuples-de-gb.py. SQLite reads use `node:sqlite`; the
 *   seeded PRNG lives in scripts/lib/python-random.ts (see its note on RNG equivalence).
 *
 *   Postcode generation strategy:
 *
 *   - **DE** (5-digit ZIP). German postcodes are organized into ten leading-digit regions (`0X` is
 *       Saxony/Thuringia, `1X` is Brandenburg/Berlin, `8X` is southern Bavaria, etc.). Per region,
 *       we sample from a state-appropriate range. The model is learning the SHAPE (5 digits,
 *       2-digit prefix consistent with the locality's region), not the exact mapping.
 *   - **GB** (alphanumeric). UK postcodes are `<area><district> <sector><unit>` — e.g. `W1J 5LJ`, `SW1A
 *       1AA`, `EC1V 9HG`. Areas correspond to regions (London = various inner-area codes;
 *       Manchester = `M`; etc.). We use a per-region prefix table and generate a synthetic
 *       sector+unit on the fly.
 *
 *   Usage: node --experimental-strip-types scripts/extract-tuples-de-gb.ts\
 *   --sqlite /mnt/playpen/mailwoman-data/wof/admin-global-priority.db\
 *   --output /tmp/tuples-de-gb.jsonl\
 *   --limit-de 5000 --limit-gb 5000
 */

import { closeSync, openSync, writeSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { SeededRandom } from "./lib/python-random.ts"

const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")

// --- DE postcode prefix mapping (per state, leading digits) -------------------------------
// Per https://en.wikipedia.org/wiki/Postal_codes_in_Germany — approximate by state.
const DE_REGION_POSTCODES: Record<string, [number, number]> = {
	Sachsen: [10, 19], // 01xxx–09xxx
	Saxony: [10, 19],
	Berlin: [101, 141],
	Brandenburg: [140, 199],
	"Mecklenburg-Vorpommern": [170, 199],
	Hamburg: [200, 229],
	"Schleswig-Holstein": [230, 270],
	Niedersachsen: [260, 380],
	"Lower Saxony": [260, 380],
	Bremen: [270, 289],
	"Nordrhein-Westfalen": [320, 599],
	"North Rhine-Westphalia": [320, 599],
	Hessen: [340, 360],
	Hesse: [340, 360],
	"Rheinland-Pfalz": [550, 569],
	"Rhineland-Palatinate": [550, 569],
	Saarland: [660, 669],
	"Baden-Württemberg": [680, 799],
	Bayern: [800, 989],
	Bavaria: [800, 989],
	Thüringen: [980, 999],
	Thuringia: [980, 999],
}
const DE_DEFAULT_RANGE: [number, number] = [100, 999]

// --- GB area-code prefix mapping (per region) --------------------------------------------
// https://en.wikipedia.org/wiki/Postcodes_in_the_United_Kingdom — approximate by region.
const GB_REGION_AREAS: Record<string, string[]> = {
	England: [
		"B",
		"BR",
		"BS",
		"CB",
		"CO",
		"CT",
		"DA",
		"DT",
		"E",
		"EC",
		"EN",
		"GU",
		"HA",
		"KT",
		"L",
		"LE",
		"LN",
		"M",
		"ME",
		"MK",
		"N",
		"NE",
		"NW",
		"OX",
		"PE",
		"PO",
		"RG",
		"RH",
		"SE",
		"SK",
		"SL",
		"SM",
		"SO",
		"SR",
		"SS",
		"SW",
		"TF",
		"TN",
		"TS",
		"TW",
		"UB",
		"W",
		"WA",
		"WC",
		"WD",
		"WN",
		"WR",
		"WS",
		"WV",
		"YO",
	],
	Scotland: ["AB", "DD", "DG", "EH", "FK", "G", "IV", "KA", "KW", "KY", "ML", "PA", "PH", "TD"],
	Wales: ["CF", "LD", "LL", "NP", "SA", "SY"],
	"Northern Ireland": ["BT"],
}
const GB_DEFAULT_AREAS = ["B", "M", "L", "S", "N", "SW", "SE", "E", "EC", "W", "WC"]

function genDePostcode(region: string, rng: SeededRandom): string {
	const [lo, hi] = DE_REGION_POSTCODES[region] ?? DE_DEFAULT_RANGE
	const prefix = rng.randint(lo, hi)
	const suffix = rng.randint(0, 99)

	return `${String(prefix).padStart(3, "0")}${String(suffix).padStart(2, "0")}`
}

function genGbPostcode(region: string, rng: SeededRandom): string {
	const areas = GB_REGION_AREAS[region] ?? GB_DEFAULT_AREAS
	const area = rng.choice(areas)
	// District: 1-2 digits, sometimes with a trailing letter (W1A, E14, EC1V).
	let district = String(rng.randint(1, 99))

	if (rng.random() < 0.2) {
		district += rng.choice(ASCII_UPPERCASE)
	}
	const sector = String(rng.randint(0, 9))
	const unit = rng.choices(ASCII_UPPERCASE, 2).join("")

	return `${area}${district} ${sector}${unit}`
}

interface Tuple {
	locality: string
	region: string
	postcode: string
	country: string
}

function extractCountry(dbPath: string, country: string, limit: number, rng: SeededRandom): Tuple[] {
	const conn = new DatabaseSync(dbPath, { readOnly: true })
	// WOF hierarchy: locality → (county) → region → country. The intermediate county isn't always
	// present for DE/GB so we join directly through parent_id to find the closest ancestor with a
	// non-empty name.
	const mainRows = conn
		.prepare(
			`
		SELECT s.id, s.name, p.name as parent_name, p.placetype
		FROM spr s
		LEFT JOIN spr p ON s.parent_id = p.id
		WHERE s.country = ? AND s.placetype = 'locality' AND s.is_current = 1
		ORDER BY RANDOM()
		LIMIT ?
		`
		)
		.all(country, limit) as Array<{
		id: number
		name: string | null
		parent_name: string | null
		placetype: string | null
	}>

	// For DE/GB the immediate parent may be a county; we want the region name. Walk up if needed
	// using a quick lookup.
	const sprByID = conn.prepare("SELECT name, placetype, parent_id FROM spr WHERE id = ?")
	const regionCache = new Map<number, string>()

	const resolveRegion = (startID: number | null): string | null => {
		const seen = new Set<number>()
		let curID = startID

		while (curID != null && curID > 0 && !seen.has(curID)) {
			seen.add(curID)
			const cached = regionCache.get(curID)

			if (cached !== undefined) return cached
			const row = sprByID.get(curID) as
				| { name: string | null; placetype: string | null; parent_id: number | null }
				| undefined

			if (!row) return null
			const { name, placetype, parent_id } = row

			if (placetype === "region") {
				regionCache.set(curID, name as string)

				return name
			}
			curID = parent_id
		}

		return null
	}

	const pcGen = country === "DE" ? genDePostcode : country === "GB" ? genGbPostcode : null

	if (!pcGen) throw new Error(`unsupported country ${country}`)

	const out: Tuple[] = []

	for (const row of mainRows) {
		const sid = row.id
		const locality = row.name
		const parentName = row.parent_name
		const parentPlacetype = row.placetype

		if (!locality) continue
		let region: string | null

		if (parentPlacetype === "region" && parentName) {
			region = parentName
		} else {
			region = resolveRegion(sid)

			if (!region) continue
		}
		const postcode = pcGen(region, rng)
		out.push({
			locality,
			region,
			postcode,
			country,
		})
	}

	conn.close()

	return out
}

function main(): number {
	const { values } = parseArgs({
		options: {
			sqlite: { type: "string" },
			output: { type: "string" },
			"limit-de": { type: "string", default: "5000" },
			"limit-gb": { type: "string", default: "5000" },
			seed: { type: "string", default: "42" },
		},
	})

	if (!values.sqlite || !values.output) {
		console.error("error: the following arguments are required: --sqlite, --output")
		process.exit(2)
	}

	const limitDe = parseInt(values["limit-de"]!, 10)
	const limitGb = parseInt(values["limit-gb"]!, 10)
	const seed = parseInt(values.seed!, 10)

	const rng = new SeededRandom(seed)
	console.error(`Extracting up to ${limitDe} DE + ${limitGb} GB tuples...`)

	const de = extractCountry(values.sqlite, "DE", limitDe, rng)
	console.error(`  DE: ${de.length} tuples`)
	const gb = extractCountry(values.sqlite, "GB", limitGb, rng)
	console.error(`  GB: ${gb.length} tuples`)

	const fd = openSync(values.output, "w")

	try {
		for (const row of [...de, ...gb]) {
			writeSync(fd, JSON.stringify(row) + "\n")
		}
	} finally {
		closeSync(fd)
	}
	console.error(`Wrote ${de.length + gb.length} tuples to ${values.output}`)

	return 0
}

if (import.meta.main) {
	process.exit(main())
}
