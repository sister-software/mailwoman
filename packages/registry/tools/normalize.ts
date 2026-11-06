/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turns the pinned sources into the reviewable normalized JSON the compiler reads.
 *
 *   Every record keeps the source's own identity (`entityID`), the code as the source spells it, and the source's
 *   status words. Each record comes from one source: a country record from Wikidata, an airport record from
 *   OurAirports. An airport's `country` is the alpha-2 string OurAirports states, with a status that records whether
 *   that string is an officially assigned ISO code, a source extension such as `XK`, or absent.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { TextSpliterator } from "spliterator"

import { type SourceDefinition, type SourceLock, sourcePath, SOURCES } from "#sdk/sources"

/**
 * One ISO 3166-1 entry.
 */
export interface CountryRecord {
	/**
	 * The Wikidata item, such as `wikidata:Q408`.
	 */
	entityID: string
	alpha2: string
	alpha3: string
	numeric: string
	name: string
	/**
	 * `officially-assigned` for a current entry.
	 * `formerly-used` when the source records a dissolution date.
	 */
	status: "officially-assigned" | "formerly-used"
	/**
	 * The dissolution date the source states, for a `formerly-used` entry.
	 */
	dissolved?: string
}

/**
 * One OurAirports row that holds an IATA code.
 */
export interface AirportRecord {
	/**
	 * The OurAirports row id, such as `ourairports:3632`.
	 */
	entityID: string
	iata: string
	/**
	 * The `icao_code` column, read as the ICAO assignment.
	 * `ident` and `gps_code` are other identifiers.
	 */
	icao: string | null
	name: string
	facility: string
	scheduledService: boolean
	latitude: number
	longitude: number
	/**
	 * The `iso_country` column as the source spells it, or null when empty.
	 */
	country: string | null
	/**
	 * Whether `country` is an officially assigned ISO 3166-1 alpha-2 code, a source extension, or absent.
	 */
	countryStatus: "iso3166-1" | "source-extension" | "unstated"
	isoRegion: string | null
	municipality: string | null
}

export interface NormalizedCountries {
	profile: string
	source: string
	normalizationVersion: number
	records: CountryRecord[]
}

export interface NormalizedAirports {
	profile: string
	source: string
	normalizationVersion: number
	records: AirportRecord[]
}

/**
 * The coverage a profile declares: what each namespace's artifact can and cannot answer.
 */
export interface CoverageDeclaration {
	profile: string
	namespaces: Record<
		string,
		{
			source: string
			count: number
			statuses?: Record<string, number>
			kinds?: string[]
			unsupported?: string[]
			missMeans: string
		}
	>
}

/**
 * The version of the normalization rules below.
 *
 * A change to a rule that moves a record's bytes moves this number.
 */
export const NORMALIZATION_VERSION = 1

interface SPARQLResults {
	results: { bindings: Array<Record<string, { type: string; value: string }>> }
}

const ALPHA2 = /^[A-Z]{2}$/
const ALPHA3 = /^[A-Z]{3}$/
const NUMERIC = /^\d{3}$/

function sourceDefinition(id: SourceDefinition["id"]): SourceDefinition {
	const found = SOURCES.find((candidate) => candidate.id === id)

	if (!found) throw new Error(`no source ${id}`)

	return found
}

/**
 * Reads the Wikidata answer into country records, sorted by alpha-2 then item id.
 *
 * A code outside its grammar is an error naming the item, because the compiler's key
 * space cannot hold it and an omitted row would be a silent loss.
 */
export function normalizeCountries(results: SPARQLResults, profile: string): NormalizedCountries {
	const records: CountryRecord[] = []
	const seen = new Set<string>()

	for (const binding of results.results.bindings) {
		const qid = binding["item"]?.value.split("/").at(-1)
		const alpha2 = binding["alpha2"]?.value
		const alpha3 = binding["alpha3"]?.value
		const numeric = binding["numeric"]?.value

		if (!qid || !alpha2 || !alpha3 || !numeric) throw new Error(`incomplete binding: ${stringifyJSON(binding)}`)

		if (!ALPHA2.test(alpha2) || !ALPHA3.test(alpha3) || !NUMERIC.test(numeric)) {
			throw new Error(`${qid}: codes ${alpha2}/${alpha3}/${numeric} are outside the ISO 3166-1 grammars`)
		}

		// The dissolution date can repeat an item, and the first row keeps it.
		if (seen.has(qid)) continue

		seen.add(qid)

		const dissolved = binding["dissolved"]?.value

		records.push({
			entityID: `wikidata:${qid}`,
			alpha2,
			alpha3,
			numeric,
			name: binding["itemLabel"]?.value ?? qid,
			status: dissolved ? "formerly-used" : "officially-assigned",
			...(dissolved ? { dissolved } : {}),
		})
	}

	const sorted = records.toSorted(
		(a, b) => a.alpha2.localeCompare(b.alpha2, "en") || a.entityID.localeCompare(b.entityID, "en")
	)

	assertUniqueCurrent(sorted)

	return { profile, source: "wikidata-iso3166-1", normalizationVersion: NORMALIZATION_VERSION, records: sorted }
}

/**
 * Two current entries cannot share a code.
 * Two historical entries, or one of each, can.
 */
function assertUniqueCurrent(records: readonly CountryRecord[]): void {
	for (const field of ["alpha2", "alpha3", "numeric"] as const) {
		const held = new Map<string, string>()

		for (const record of records) {
			if (record.status !== "officially-assigned") continue

			const other = held.get(record[field])

			if (other) throw new Error(`${field} ${record[field]} is held by ${other} and ${record.entityID}`)

			held.set(record[field], record.entityID)
		}
	}
}

/**
 * Splits one CSV line whose fields are all double-quoted, as OurAirports writes them,
 * with `""` as an escaped quote.
 */
export function splitQuotedCSVLine(line: string): string[] {
	const cells: string[] = []
	let cell = ""
	let quoted = false

	for (let index = 0; index < line.length; index++) {
		const char = line[index]!

		if (quoted) {
			if (char === '"') {
				if (line[index + 1] === '"') {
					cell += '"'

					index++
				} else {
					quoted = false
				}
			} else {
				cell += char
			}
		} else if (char === '"') {
			quoted = true
		} else if (char === ",") {
			cells.push(cell)
			cell = ""
		} else {
			cell += char
		}
	}

	cells.push(cell)

	return cells
}

/**
 * The lines of a CSV text, with the header first and no empty line.
 */
function csvLines(csv: string): string[] {
	return TextSpliterator.from(csv)
		.filter((line) => line.length > 0)
		.toArray()
}

function columnIndex(header: readonly string[], name: string, file: string): number {
	const index = header.indexOf(name)

	if (index === -1) throw new Error(`${file} has no ${name} column. The header is ${header.join(",")}`)

	return index
}

/**
 * Reads the OurAirports CSV into airport records: every row with an `iata_code`, sorted by code.
 *
 * `currentAlpha2` is the set of officially assigned alpha-2 codes,
 * used only to label the row's country status.
 */
export function normalizeAirports(
	csv: string,
	currentAlpha2: ReadonlySet<string>,
	profile: string
): NormalizedAirports {
	const lines = csvLines(csv)
	const header = splitQuotedCSVLine(lines[0]!)
	const column = (name: string): number => columnIndex(header, name, "airports.csv")

	const at = {
		id: column("id"),
		type: column("type"),
		name: column("name"),
		latitude: column("latitude_deg"),
		longitude: column("longitude_deg"),
		country: column("iso_country"),
		region: column("iso_region"),
		municipality: column("municipality"),
		scheduled: column("scheduled_service"),
		icao: column("icao_code"),
		iata: column("iata_code"),
	}

	const records: AirportRecord[] = []
	const held = new Map<string, string>()

	for (const line of lines.slice(1)) {
		const cells = splitQuotedCSVLine(line)

		if (cells.length !== header.length)
			throw new Error(`airports.csv row has ${cells.length} cells: ${line.slice(0, 80)}`)

		const iata = cells[at.iata]!

		if (!iata) continue

		if (!ALPHA3.test(iata)) throw new Error(`row ${cells[at.id]}: iata_code ${stringifyJSON(iata)} is outside [A-Z]{3}`)

		const other = held.get(iata)

		if (other) throw new Error(`iata ${iata} is held by rows ${other} and ${cells[at.id]}`)

		held.set(iata, cells[at.id]!)

		const latitude = Number(cells[at.latitude])
		const longitude = Number(cells[at.longitude])

		if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
			throw new TypeError(`row ${cells[at.id]}: unreadable coordinate ${cells[at.latitude]},${cells[at.longitude]}`)
		}

		const country = cells[at.country] || null
		const icao = cells[at.icao] || null

		records.push({
			entityID: `ourairports:${cells[at.id]}`,
			iata,
			icao,
			name: cells[at.name]!,
			facility: cells[at.type]!,
			scheduledService: cells[at.scheduled] === "yes",
			latitude,
			longitude,
			country,
			countryStatus: country ? (currentAlpha2.has(country) ? "iso3166-1" : "source-extension") : "unstated",
			isoRegion: cells[at.region] || null,
			municipality: cells[at.municipality] || null,
		})
	}

	return {
		profile,
		source: "ourairports-airports",
		normalizationVersion: NORMALIZATION_VERSION,
		records: records.toSorted((a, b) => a.iata.localeCompare(b.iata, "en")),
	}
}

/**
 * Checks the country set against OurAirports' own country list and reports each side's extras.
 *
 * The two sources disagree on purpose: OurAirports adds `XK`, `XP` and `ZZ` as extensions
 * and lists no entry for a territory with no airport.
 * The report goes in the coverage declaration rather than changing either dataset.
 */
export function compareCountryLists(
	countries: readonly CountryRecord[],
	countriesCSV: string
): { onlyOurAirports: string[]; onlyWikidata: string[] } {
	const lines = csvLines(countriesCSV)
	const header = splitQuotedCSVLine(lines[0]!)
	const codeIndex = columnIndex(header, "code", "countries.csv")
	const ourAirports = new Set(lines.slice(1).map((line) => splitQuotedCSVLine(line)[codeIndex]!))

	const current = new Set(
		countries.filter((record) => record.status === "officially-assigned").map((record) => record.alpha2)
	)

	return {
		onlyOurAirports: [...ourAirports].filter((code) => !current.has(code)).toSorted(),
		onlyWikidata: [...current].filter((code) => !ourAirports.has(code)).toSorted(),
	}
}

/**
 * The coverage declaration for the open profile.
 */
export function declareCoverage(
	countries: NormalizedCountries,
	airports: NormalizedAirports,
	comparison: ReturnType<typeof compareCountryLists>
): CoverageDeclaration {
	const statuses: Record<string, number> = {}

	for (const record of countries.records) {
		statuses[record.status] = (statuses[record.status] ?? 0) + 1
	}

	const current = countries.records.filter((record) => record.status === "officially-assigned").length
	const airportCountryStatuses: Record<string, number> = {}

	for (const record of airports.records) {
		airportCountryStatuses[record.countryStatus] = (airportCountryStatuses[record.countryStatus] ?? 0) + 1
	}

	const missMeans =
		"not-found-in-snapshot: the source holds no such code, and the issuing authority may still have assigned it"

	return {
		profile: countries.profile,
		namespaces: {
			"iso3166-1-alpha2": { source: countries.source, count: current, statuses, missMeans },
			"iso3166-1-alpha3": { source: countries.source, count: current, statuses, missMeans },
			"iso3166-1-numeric": { source: countries.source, count: current, statuses, missMeans },
			"iata-location": {
				source: airports.source,
				count: airports.records.length,
				kinds: ["airport"],
				unsupported: ["metropolitan", "intermodal", "rail", "bus"],
				statuses: airportCountryStatuses,
				missMeans,
			},
			"icao-location": {
				source: airports.source,
				count: airports.records.filter((record) => record.icao).length,
				kinds: ["airport"],
				unsupported: ["a location with no IATA code: the source rows without iata_code are left unread"],
				missMeans,
			},
			$countryListComparison: {
				source: "ourairports-countries",
				count: comparison.onlyOurAirports.length + comparison.onlyWikidata.length,
				kinds: [
					`onlyOurAirports: ${comparison.onlyOurAirports.join(",")}`,
					`onlyWikidata: ${comparison.onlyWikidata.join(",")}`,
				],
				missMeans: "a comparison rather than a namespace",
			},
		},
	}
}

/**
 * Serializes a normalized collection with one record per line, so a source update diffs by record.
 *
 * The envelope keys come first, then `records`, each on its own line.
 */
export function formatNormalized(collection: NormalizedCountries | NormalizedAirports): string {
	const { records, ...envelope } = collection
	const head = stringifyJSON(envelope).slice(1, -1)
	const body = records.map((record) => `\t\t${stringifyJSON(record)}`).join(",\n")

	return `{${head},\n\t"records": [\n${body}\n\t]\n}\n`
}

/**
 * Reads the three pinned sources and normalizes them, refusing bytes the lock does not describe.
 */
export async function normalizeFromLock(lock: SourceLock): Promise<{
	countries: NormalizedCountries
	airports: NormalizedAirports
	coverage: CoverageDeclaration
}> {
	for (const definition of SOURCES.filter((candidate) => candidate.terms.elected)) {
		const locked = lock.sources[definition.id]
		const digest = await sha256File(sourcePath(definition))

		if (!locked) throw new Error(`${definition.id} is outside the lock`)

		if (digest !== locked.sha256) {
			throw new Error(`${definition.id}: file digest ${digest} differs from the lock's ${locked.sha256}`)
		}
	}

	const results = await readLocalJSONFile<SPARQLResults>(sourcePath(sourceDefinition("wikidata-iso3166-1")))
	const countries = normalizeCountries(results, lock.profile)

	const current = new Set(
		countries.records.filter((record) => record.status === "officially-assigned").map((record) => record.alpha2)
	)

	const airports = normalizeAirports(
		await readLocalTextFile(sourcePath(sourceDefinition("ourairports-airports"))),
		current,
		lock.profile
	)

	const comparison = compareCountryLists(
		countries.records,
		await readLocalTextFile(sourcePath(sourceDefinition("ourairports-countries")))
	)

	return { countries, airports, coverage: declareCoverage(countries, airports, comparison) }
}
