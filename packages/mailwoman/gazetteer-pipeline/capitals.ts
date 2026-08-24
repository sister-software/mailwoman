/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `data/gazetteer/capitals-v1.json` — the CAPITAL-STATUS reference (#1880): every national
 *   capital (`PPLC`) and first-order administrative seat (`PPLA`) in the GeoNames gazetteer dumps,
 *   each carrying its coordinate AND its folded name set (name + romanization + alternate names).
 *   The consumer (`@mailwoman/resolver-wof-sqlite/capitals`) matches a candidate by country +
 *   proximity + name membership — all three conjuncts, because the first board run matched on
 *   coordinates alone and promoted capital-ADJACENT namesakes (North Salt Lake beside the Utah
 *   seat) instead of capitals; the alternate names are what keep exonym rows ("Vienna" for Wien)
 *   matching without a hand-kept exonym list.
 *
 *   Feature codes are matched EXACTLY: `PPLA2`–`PPLA4` (lower-order seats) and `PPLCH` (historical
 *   capital) stay out. `countryInfo.txt` — the same source's own catalog — grades the extraction:
 *   a catalog country whose dump yields no `PPLC` row, and a catalog capital NAME that matches none
 *   of the extracted rows' names, are both recorded in the coverage block rather than silently
 *   absorbed (the partial-reader rule: a reference that could not measure a country must say so).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { looksLikeGazetteerDump, parseCountryInfo } from "@mailwoman/corpus/tools"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

/**
 * One capital or admin-1 seat. `latitude`/`longitude` are rounded to 4 decimals (~11 m) — the consumer matches at
 * kilometre radius, and the rounding keeps the committed file small.
 */
export interface CapitalReferenceEntry {
	/**
	 * GeoNames `geonameid` — provenance back-pointer, never a join key.
	 */
	id: number
	name: string
	/**
	 * ISO alpha-2, uppercase — from the dump row's own country column.
	 */
	country: string
	latitude: number
	longitude: number
	level: "national" | "admin1"
	/**
	 * Folded name keys (name + romanization + alternate names) — the consumer's name-membership conjunct, which is what
	 * keeps the coordinate radius from promoting a capital's same-name neighbours. Folded with the SAME
	 * `normalizeLocalityForKey` the candidate gazetteer keys with.
	 */
	k: string[]
}

export interface CapitalsReference {
	version: 1
	generated_by: string
	source: string
	license: string
	attribution: string
	coverage: {
		countries_scanned: number
		national: number
		admin1: number
		/**
		 * Catalog countries with no dump file on disk — countries this reference could not measure.
		 */
		missing_dumps: string[]
		/**
		 * Catalog countries whose `<CC>.txt` is not a 19-column gazetteer dump (GeoNames' postal exports share the
		 * basename). NOT counted as scanned: a wrong-format file cannot answer the capital question, and "scanned, found
		 * none" would be the partial-reader lie.
		 */
		wrong_format: string[]
		/**
		 * Scanned catalog countries whose dump carries no `PPLC` row — a fact about the source.
		 */
		missing_national: string[]
		/**
		 * Catalog rows whose stated capital name (folded) matches no extracted row name for that country — worth a read,
		 * not a failure: multi-capital countries and spelling drift land here.
		 */
		capital_name_mismatches: string[]
	}
	entries: CapitalReferenceEntry[]
}

/**
 * Feature codes admitted, mapped to the reference level. Exact codes only — `startsWith("PPLA")` would admit the
 * county-seat tiers this reference exists to exclude.
 */
const LEVEL_BY_FEATURE_CODE: Record<string, CapitalReferenceEntry["level"]> = {
	PPLC: "national",
	PPLA: "admin1",
}

/**
 * Coordinate decimals kept in the committed file (4 ≈ 11 m; the consumer matches at km radius).
 */
const COORD_DECIMALS = 4

const roundCoord = (value: number): number => Number(value.toFixed(COORD_DECIMALS))

/**
 * Extract the capital/seat rows from ONE GeoNames dump (tab-separated, 19 columns; 0-indexed: 0 `geonameid`, 1 `name`,
 * 2 `asciiname`, 3 `alternatenames`, 4/5 lat/lon, 6 feature class, 7 feature code, 8 country code). The folded name set
 * (`k`) covers name + asciiname + every alternate name, so exonym rows match at the consumer.
 */
export function parseCapitalRows(text: string): CapitalReferenceEntry[] {
	const rows: CapitalReferenceEntry[] = []

	// Walk lines by index rather than split("\n"): a dump runs to ~350 MB / millions of rows, and only
	// the few carrying a capital code are worth a column split. The substring probes are the
	// pre-filter — the feature code sits between tabs, so a capital row must contain the exact
	// delimited code, and plain populated-place rows (the millions) never split.
	for (let start = 0; start < text.length;) {
		const end = text.indexOf("\n", start)
		const line = end === -1 ? text.slice(start) : text.slice(start, end)

		start = end === -1 ? text.length : end + 1

		if (!line.includes("\tPPLC\t") && !line.includes("\tPPLA\t")) continue

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- pre-filtered: only capital-candidate rows reach this split, a few dozen per dump
		const cols = line.split("\t")
		const level = cols[6] === "P" ? LEVEL_BY_FEATURE_CODE[cols[7] ?? ""] : undefined

		if (!level) continue

		const id = Number(cols[0])
		const name = cols[1]?.trim() ?? ""
		const country = cols[8]?.trim().toUpperCase() ?? ""
		const latitude = Number(cols[4])
		const longitude = Number(cols[5])

		if (
			!Number.isFinite(id) ||
			!name ||
			country.length !== 2 ||
			!Number.isFinite(latitude) ||
			!Number.isFinite(longitude)
		) {
			continue
		}

		const foldedNames = new Set<string>()

		for (const surface of [name, cols[2] ?? "", ...(cols[3] ?? "").split(",")]) {
			const key = String(normalizeLocalityForKey(surface.trim()))

			if (key) {
				foldedNames.add(key)
			}
		}

		rows.push({
			id,
			name,
			country,
			latitude: roundCoord(latitude),
			longitude: roundCoord(longitude),
			level,
			k: [...foldedNames].toSorted(),
		})
	}

	return rows
}

export interface BuildCapitalsOptions {
	/**
	 * Directory holding `countryInfo.txt` + the `<CC>.txt` dumps (`mailwoman corpus fetch geonames-dump`).
	 */
	geonamesDir: string
	outPath: string
}

export interface BuildCapitalsResult {
	outPath: string
	coverage: CapitalsReference["coverage"]
}

/**
 * Read every catalog country's dump, extract the capital rows, grade the extraction against the catalog's own capital
 * names, and write the reference. Throws when `countryInfo.txt` is absent — without the catalog there is no
 * denominator, and a reference built from "whatever files exist" cannot state what it failed to cover.
 */
export function buildCapitalsReference(options: BuildCapitalsOptions): BuildCapitalsResult {
	const countryInfoPath = join(options.geonamesDir, "countryInfo.txt")

	if (!existsSync(countryInfoPath)) {
		throw new Error(
			`countryInfo.txt not found in ${options.geonamesDir} — run \`mailwoman corpus fetch geonames-dump\` first; ` +
				"the catalog is the coverage denominator"
		)
	}

	const catalog = parseCountryInfo(readFileSync(countryInfoPath, "utf8"))

	const entries: CapitalReferenceEntry[] = []
	const missingDumps: string[] = []
	const wrongFormat: string[] = []
	const missingNational: string[] = []
	const nameMismatches: string[] = []
	let scanned = 0

	for (const { country, capital } of catalog) {
		const dumpPath = join(options.geonamesDir, `${country}.txt`)

		if (!existsSync(dumpPath)) {
			missingDumps.push(country)

			continue
		}

		const text = readFileSync(dumpPath, "utf8")

		if (!looksLikeGazetteerDump(text)) {
			wrongFormat.push(country)

			continue
		}

		scanned++

		const rows = parseCapitalRows(text).filter((r) => r.country === country)

		entries.push(...rows)

		const nationals = rows.filter((r) => r.level === "national")

		if (!nationals.length) {
			// A stated capital with no PPLC row is a gap; a catalog row with no capital (AQ, BV) is not.
			if (capital) {
				missingNational.push(country)
			}

			continue
		}

		if (capital && !nationals.some((r) => r.k.includes(String(normalizeLocalityForKey(capital))))) {
			nameMismatches.push(`${country}: catalog says "${capital}"`)
		}
	}

	entries.sort((a, b) => a.country.localeCompare(b.country) || a.id - b.id)

	const reference: CapitalsReference = {
		version: 1,
		generated_by: "mailwoman gazetteer capitals (source: GeoNames dumps, PPLC + PPLA exact)",
		source: "https://download.geonames.org/export/dump",
		license: "CC-BY-4.0",
		attribution: "GeoNames",
		coverage: {
			countries_scanned: scanned,
			national: entries.filter((e) => e.level === "national").length,
			admin1: entries.filter((e) => e.level === "admin1").length,
			missing_dumps: missingDumps,
			wrong_format: wrongFormat,
			missing_national: missingNational,
			capital_name_mismatches: nameMismatches,
		},
		entries,
	}

	// One entry per line: the header reads like JSON, the entry block diffs like a table.
	const head = JSON.stringify({ ...reference, entries: undefined }, null, "\t").replace(/\n\}$/, ",\n")
	const body = reference.entries.map((e) => "\t\t" + JSON.stringify(e)).join(",\n")

	mkdirSync(dirname(options.outPath), { recursive: true })
	writeFileSync(options.outPath, `${head}\t"entries": [\n${body}\n\t]\n}\n`)

	return { outPath: options.outPath, coverage: reference.coverage }
}
