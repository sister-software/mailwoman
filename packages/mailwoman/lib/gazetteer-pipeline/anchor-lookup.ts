/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readUnquotedTSVText } from "@mailwoman/core/fs/delimited"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { finished, openWriteStream } from "@mailwoman/core/fs/streams"
import { pyFloat, pyRound } from "@mailwoman/core/numeric"
import { once } from "@mailwoman/core/utils/events"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

const GAZETTEER_ROW_COLUMNS = 7

const ZCTA_SOURCE = "census-zcta-2024"

type Centroid = [number, number, string | null]

function fiveDigit(name: string | null | undefined): string | null {
	const n = (name || "").trim().toUpperCase()

	return /^[0-9]{5}$/.test(n) ? n : null
}

function placed(lat: number, lon: number): boolean {
	return lat !== 0 || lon !== 0
}

function loadIntl(country: string): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(wofDatabasePath("postalcode-intl.db"))

	const rows = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND country=?")
		.all(country) as Array<{ name: string; latitude: number; longitude: number }>

	for (const row of rows) {
		const pc = fiveDigit(row.name)

		if (pc) {
			const lat = Number(row.latitude)
			const lon = Number(row.longitude)
			out.set(pc, [lat, lon, placed(lat, lon) ? "wof" : null])
		}
	}

	return out
}

function loadUs(): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(wofDatabasePath("postalcode-us.db"))
	const hasSources = con.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='centroid_source'").get()
	const srcJoin = hasSources ? "LEFT JOIN centroid_source cs ON cs.id=spr.id" : ""
	const srcCol = hasSources ? "cs.source" : "NULL"

	const rows = con
		.prepare(
			`SELECT spr.name, spr.latitude, spr.longitude, ${srcCol} AS src FROM spr ${srcJoin} ` +
				"WHERE spr.placetype='postalcode' AND spr.is_current!=0"
		)
		.all() as Array<{ name: string; latitude: number; longitude: number; src: string | null }>

	for (const row of rows) {
		const pc = fiveDigit(row.name)

		if (pc) {
			const lat = Number(row.latitude)
			const lon = Number(row.longitude)
			out.set(pc, [lat, lon, placed(lat, lon) ? row.src || "wof" : null])
		}
	}

	return out
}

const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/

const GB_INWARD_LENGTH = 3

const NL_PC6_KEY = /^\d{4}[A-Z]{2}$/

const HAS_LETTERS = /[A-Z]/

const GB_SOURCE = "os-codepoint-open"
const GB_OUTWARD_SOURCE = "os-codepoint-open-outward"
const NL_SOURCE = "cbs-pc6"

function loadGBCodePoint(): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(wofDatabasePath("postalcode-gb-codepoint.db"))

	const rows = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND is_current!=0")
		.all() as Array<{ name: string; latitude: number; longitude: number }>

	for (const row of rows) {
		const pc = (row.name || "").trim().toUpperCase()

		if (!GB_UNIT_KEY.test(pc)) continue
		const lat = Number(row.latitude)
		const lon = Number(row.longitude)

		out.set(pc, [lat, lon, placed(lat, lon) ? GB_SOURCE : null])
	}

	return out
}

function addGBOutwardKeys(units: Map<string, Centroid>): number {
	const acc = new Map<string, { lat: number; lon: number; n: number }>()

	for (const [pc, [lat, lon, source]] of units) {
		if (source === null) continue
		const outward = pc.slice(0, -GB_INWARD_LENGTH)
		const bucket = acc.get(outward)

		if (bucket) {
			bucket.lat += lat
			bucket.lon += lon

			bucket.n++
		} else {
			acc.set(outward, { lat, lon, n: 1 })
		}
	}

	for (const [outward, { lat, lon, n }] of acc) {
		units.set(outward, [lat / n, lon / n, GB_OUTWARD_SOURCE])
	}

	return acc.size
}

function loadNLPC6(): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(wofDatabasePath("postalcode-nl-pc6.db"))

	const rows = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND is_current!=0")
		.all() as Array<{ name: string; latitude: number; longitude: number }>

	for (const row of rows) {
		const pc = (row.name || "").trim().toUpperCase()

		if (!NL_PC6_KEY.test(pc)) continue
		const lat = Number(row.latitude)
		const lon = Number(row.longitude)

		out.set(pc, [lat, lon, placed(lat, lon) ? NL_SOURCE : null])
	}

	return out
}

async function loadZCTA(path: string): Promise<Map<string, [number, number]>> {
	const out = new Map<string, [number, number]>()

	for (const row of readUnquotedTSVText(await readLocalTextFile(path))) {
		const fields = row.map((f) => f.trim())
		const pc = fields.length ? fiveDigit(fields[0]) : null

		if (!pc || fields.length < GAZETTEER_ROW_COLUMNS) continue
		const lat = pyFloat(fields[5])
		const lon = pyFloat(fields[6])

		if (lat === null || lon === null) continue

		if (placed(lat, lon)) {
			out.set(pc, [lat, lon])
		}
	}

	return out
}

function pyJSONStr(s: string): string {
	let out = '"'

	for (const ch of s) {
		const code = ch.codePointAt(0)!

		if (ch === '"') {
			out += '\\"'
		} else if (ch === "\\") {
			out += "\\\\"
		} else if (ch === "\n") {
			out += "\\n"
		} else if (ch === "\r") {
			out += "\\r"
		} else if (ch === "\t") {
			out += "\\t"
		} else if (code < 0x20) {
			out += "\\u" + code.toString(16).padStart(4, "0")
		} else {
			out += ch
		}
	}

	return out + '"'
}

function pyJSONNum(x: number): string {
	if (Number.isInteger(x)) return Object.is(x, -0) ? "-0.0" : `${x}.0`

	return String(x)
}

function pyJSONValue(v: unknown): string {
	if (v === null) return "null"

	if (typeof v === "number") return pyJSONNum(v)

	if (typeof v === "string") return pyJSONStr(v)

	if (Array.isArray(v)) return "[" + v.map(pyJSONValue).join(", ") + "]"
	const parts: string[] = []

	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		parts.push(pyJSONStr(k) + ": " + pyJSONValue(val))
	}

	return "{" + parts.join(", ") + "}"
}

type LookupRow = [Record<string, number>, number, number, string | null]

/**
 * Lists the pilot anchor-lookup countries, all with five-digit postcodes, which
 * {@link buildAnchorLookup} uses by default so an argument-free build matches the shipped pilot lookup.
 */
export const ANCHOR_PILOT_COUNTRIES = ["DE", "FR", "US"] as const

/**
 * Lists the v2 anchor-lookup countries: the pilot set plus the countries with
 * licence-clean postcode sources.
 *
 * Order sets centroid priority, and the pilot countries lead so a code they
 * already covered keeps its centroid.
 */
export const ANCHOR_V2_COUNTRIES = ["DE", "FR", "US", "GB", "NL", "ES", "IT"] as const

const COUNTRY_LOADERS: Record<string, () => Map<string, Centroid>> = {
	DE: () => loadIntl("DE"),
	ES: () => loadIntl("ES"),
	FR: () => loadIntl("FR"),
	GB: loadGBCodePoint,
	IT: () => loadIntl("IT"),
	NL: loadNLPC6,
	US: loadUs,
}

const WRITE_FLUSH_ENTRIES = 4096

/**
 * Configures {@link buildAnchorLookup}: the output path, an optional ZCTA gazetteer file for
 * filling US centroids, the countries to include, and whether to add GB outward-code keys.
 */
export interface AnchorLookupOptions {
	output: string
	zcta?: string

	/**
	 * Lists the country codes to include in centroid-priority order, defaulting
	 * to {@linkcode ANCHOR_PILOT_COUNTRIES}.
	 *
	 * Every code must have a loader, which all of {@linkcode ANCHOR_V2_COUNTRIES} do.
	 */
	include?: readonly string[]

	/**
	 * Adds GB outward-district keys beside the unit keys; it defaults to `true`
	 * and is ignored unless GB is included.
	 */
	gbOutward?: boolean
}

/**
 * Summarizes an anchor-lookup build so callers can assert on its counts instead of parsing the log line.
 */
export interface AnchorLookupStats {
	total: number

	/**
	 * Counts the keys whose posterior names each country, so a colliding key counts in every member country.
	 */
	byCountry: Record<string, number>

	/**
	 * Counts the keys that contain at least one `A-Z` letter.
	 */
	letterKeyCount: number

	/**
	 * Counts the keys whose posterior names more than one country.
	 */
	collisions: number

	/**
	 * Counts the GB outward-district keys, which `total` already includes; it is 0
	 * when GB is excluded or `gbOutward` is false.
	 */
	gbOutwardKeys: number

	/**
	 * Counts keys per centroid-source label, where the `null` label counts placeholder
	 * keys that carry membership but no centroid.
	 */
	bySource: Map<string | null, number>

	/**
	 * Counts the US keys whose centroid came from the ZCTA file in this build.
	 */
	zctaFilled: number
}

/**
 * Builds the postcode anchor lookup JSON, mapping each postcode to a uniform country posterior
 * and the first available centroid, and returns build statistics.
 *
 * @throws If `include` names a country with no loader.
 */
export async function buildAnchorLookup(args: AnchorLookupOptions): Promise<AnchorLookupStats> {
	const countries = (args.include?.length ? args.include : ANCHOR_PILOT_COUNTRIES).map((c) => c.toUpperCase())

	for (const country of countries) {
		if (!COUNTRY_LOADERS[country]) {
			throw new Error(`No anchor-lookup loader for ${country} (have: ${Object.keys(COUNTRY_LOADERS).join(", ")})`)
		}
	}

	const sources: Array<[string, Map<string, Centroid>]> = countries.map((c) => [c, COUNTRY_LOADERS[c]!()])
	let gbOutwardKeys = 0

	if (countries.includes("GB") && args.gbOutward !== false) {
		gbOutwardKeys = addGBOutwardKeys(sources.find(([c]) => c === "GB")![1])
	}

	const zcta = args.zcta ? await loadZCTA(args.zcta) : new Map<string, [number, number]>()
	const allCodes = new Set<string>()

	for (const [, d] of sources) {
		for (const k of d.keys()) {
			allCodes.add(k)
		}
	}

	const sortedCodes = [...allCodes].toSorted()
	const byCountry: Record<string, number> = Object.fromEntries(countries.map((c) => [c, 0]))
	const bySource = new Map<string | null, number>()
	let collisions = 0
	let zctaFilled = 0
	let letterKeyCount = 0

	const output = openWriteStream(args.output)
	let buffer = "{"
	let written = 0

	for (const pc of sortedCodes) {
		const members = sources.filter(([, d]) => d.has(pc)).map(([c]) => c)
		const k = members.length
		const posterior: Record<string, number> = {}

		for (const c of members) {
			posterior[c] = 1 / k

			byCountry[c]!++
		}

		if (k > 1) {
			collisions++
		}

		if (HAS_LETTERS.test(pc)) {
			letterKeyCount++
		}

		let lat = 0
		let lon = 0
		let source: string | null = null

		for (const [, d] of sources) {
			const c = d.get(pc)

			if (c && placed(c[0], c[1])) {
				;[lat, lon, source] = c

				break
			}
		}

		if (source === null && members.includes("US") && zcta.has(pc)) {
			;[lat, lon] = zcta.get(pc)!
			source = ZCTA_SOURCE

			zctaFilled++
		}

		const row: LookupRow = [posterior, pyRound(lat, 5), pyRound(lon, 5), source]

		bySource.set(source, (bySource.get(source) ?? 0) + 1)

		buffer += (written ? ", " : "") + pyJSONStr(pc) + ": " + pyJSONValue(row)

		written++

		if (written % WRITE_FLUSH_ENTRIES === 0) {
			if (!output.write(buffer)) {
				await once(output, "drain")
			}

			buffer = ""
		}
	}

	output.end(buffer + "}")
	await finished(output)

	const placeholders = bySource.get(null) ?? 0

	const sourceRepr =
		"{" +
		[...bySource.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.map(([k, n]) => `'${k ?? "placeholder"}': ${n}`)
			.join(", ") +
		"}"

	const total = sortedCodes.length

	console.log(
		`${total.toLocaleString("en-US")} postcodes → ${args.output}  ` +
			`(${countries.map((c) => `${c} ${byCountry[c]!.toLocaleString("en-US")}`).join(", ")}; ` +
			`${letterKeyCount.toLocaleString("en-US")} letter-containing; ` +
			`${gbOutwardKeys.toLocaleString("en-US")} GB outward; ` +
			`${collisions.toLocaleString("en-US")} collisions; ` +
			`${zctaFilled.toLocaleString("en-US")} ZCTA-filled here; sources ${sourceRepr}; ` +
			`${placeholders.toLocaleString("en-US")} no-centroid = ${((100 * placeholders) / total).toFixed(1)}%)`
	)

	return { total, byCountry, letterKeyCount, collisions, gbOutwardKeys, bySource, zctaFilled }
}
