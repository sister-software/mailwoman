/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Samples National Address Database rows into OpenAddresses-layout CSV skeletons, measures the address
 *   shapes each state's rows carry, and tallies county ZIP-to-city tables.
 *
 *   The OA-skeleton recipes read a zipped CSV with OpenAddresses' columns, so a NAD sample written in that
 *   layout reaches them through the same reader as the OpenAddresses extracts they also read.
 */

import { matchLeadingDesignator } from "@mailwoman/codex/us"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalBuffer, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import { mulberry32 } from "@mailwoman/core/random"
import ADMZip from "adm-zip"
import { resolvePathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { composeNADLocality, decomposeNADStreet, nadHouseNumber, type NADRecord } from "#us/adapters/usgov/nad/adapter"
import { nadSkeletonFile, nadZipCityPath, type NADZipCityCounty } from "#us/recipes/skeleton-sources"

/**
 * The OpenAddresses columns a skeleton CSV carries, in OpenAddresses' order.
 */
export const NAD_SKELETON_COLUMNS = [
	"NUMBER",
	"STREET",
	"UNIT",
	"CITY",
	"DISTRICT",
	"REGION",
	"POSTCODE",
	"ID",
] as const

/**
 * One NAD row projected onto {@link NAD_SKELETON_COLUMNS}.
 */
export type NADSkeletonRow = Record<(typeof NAD_SKELETON_COLUMNS)[number], string>

const RURAL_ROUTE = /^(RR|R R|RURAL ROUTE|HC|HCR|HIGHWAY CONTRACT)\b/i
const text = (value: unknown): string => (value == null ? "" : String(value).trim())

/**
 * The unit identifier of a NAD row without its designator, as OpenAddresses' `UNIT` column mostly states it.
 *
 * NAD writes `APT 6`, `UNIT D` or a bare `200`; the recipes add their own designator in
 * front of the identifier, so the designator NAD wrote is dropped rather than doubled.
 */
export function nadUnitIdentifier(record: NADRecord): string {
	const unit = text(record.Unit) || text(record.Room)

	if (!unit) return ""

	const designator = matchLeadingDesignator(unit)
	const identifier = designator ? unit.slice(unit.indexOf(designator.matched) + designator.matched.length) : unit

	return identifier.replace(/^\s*#\s*/, "").trim()
}

/**
 * Projects one NAD record onto the OpenAddresses columns, or returns null
 * when it lacks a house number, street, locality, state or five-digit ZIP.
 *
 * A street whose name NAD publishes in capitals is written wholly in capitals,
 * because NAD spells its structured types in title case (`East MAIN Street`)
 * and a recipe would otherwise teach that mixed case.
 */
export function nadSkeletonRow(record: NADRecord): NADSkeletonRow | null {
	const number = nadHouseNumber(record)
	const street = decomposeNADStreet(record)
	const city = composeNADLocality(record)
	const region = text(record.State).toUpperCase()
	const postcode = text(record.Zip_Code)

	if (!number || !street?.full || !city || !region || !/^\d{5}$/.test(postcode)) return null

	const name = street.street ?? street.full
	const capitalized = /[A-Z]/.test(name) && name === name.toUpperCase()

	return {
		NUMBER: number,
		STREET: capitalized ? street.full.toUpperCase() : street.full,
		UNIT: nadUnitIdentifier(record),
		CITY: city,
		DISTRICT: text(record.County),
		REGION: region,
		POSTCODE: postcode,
		ID: text(record.UUID) || text(record.OBJECTID),
	}
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * The address-shape measures for one state's usable NAD rows.
 */
export interface NADStateShape {
	region: string
	/**
	 * Rows with a house number, street, locality and five-digit ZIP.
	 */
	usable: number
	unitShare: number
	/**
	 * Distinct `St_PosTyp` and `St_PreTyp` values.
	 */
	streetTypes: number
	zips: number
	/**
	 * Share of rows whose street opens with a type, such as `County Road 12` or `Farm to Market 1960`.
	 */
	prefixTypeShare: number
	numericNameShare: number
	postDirectionalShare: number
	ruralRouteShare: number
	hyphenatedNumberShare: number
	/**
	 * Share of house numbers that open with a direction letter, as Wisconsin's `E2755` does.
	 */
	gridNumberShare: number
}

interface ShapeTally {
	usable: number
	unit: number
	types: Set<string>
	zips: Set<string>
	prefixType: number
	numericName: number
	postDirectional: number
	ruralRoute: number
	hyphenated: number
	grid: number
}

const newTally = (): ShapeTally => ({
	usable: 0,
	unit: 0,
	types: new Set(),
	zips: new Set(),
	prefixType: 0,
	numericName: 0,
	postDirectional: 0,
	ruralRoute: 0,
	hyphenated: 0,
	grid: 0,
})

function tallyShape(tally: ShapeTally, record: NADRecord, row: NADSkeletonRow): void {
	tally.usable++

	if (row.UNIT) {
		tally.unit++
	}

	const postType = text(record.St_PosTyp).toUpperCase()
	const preType = text(record.St_PreTyp).toUpperCase()

	if (postType) {
		tally.types.add(postType)
	}

	if (preType) {
		tally.types.add(preType)

		tally.prefixType++
	}

	tally.zips.add(row.POSTCODE)

	if (/^\d+$/.test(text(record.St_Name))) {
		tally.numericName++
	}

	if (text(record.St_PosDir)) {
		tally.postDirectional++
	}

	if (RURAL_ROUTE.test(row.STREET)) {
		tally.ruralRoute++
	}

	if (/^\d+-\d+/.test(row.NUMBER)) {
		tally.hyphenated++
	}

	if (/^[NSEW]\d/i.test(row.NUMBER)) {
		tally.grid++
	}
}

function shapeOf(region: string, t: ShapeTally): NADStateShape {
	const share = (n: number) => (t.usable ? n / t.usable : 0)

	return {
		region,
		usable: t.usable,
		unitShare: share(t.unit),
		streetTypes: t.types.size,
		zips: t.zips.size,
		prefixTypeShare: share(t.prefixType),
		numericNameShare: share(t.numericName),
		postDirectionalShare: share(t.postDirectional),
		ruralRouteShare: share(t.ruralRoute),
		hyphenatedNumberShare: share(t.hyphenated),
		gridNumberShare: share(t.grid),
	}
}

export interface BuildNADSkeletonsOptions {
	/**
	 * The directory of FeatureServer NDJSON pages the NAD fetcher writes.
	 */
	inputDirectory: PathBuilderLike
	/**
	 * The states to sample, as USPS abbreviations.
	 */
	states: readonly string[]
	/**
	 * The most rows any one state's sample keeps.
	 */
	cap: number
	seed: number
	zipCityCounties: readonly NADZipCityCounty[]
	/**
	 * Called after each page with the count read so far.
	 */
	onPage?: (pagesRead: number, pages: number) => void
}

export interface NADSkeletonSummary {
	pages: number
	cap: number
	seed: number
	shapes: NADStateShape[]
	samples: Array<{ region: string; rows: number; zip: string; csv: string; csvSHA256: string }>
	zipCity: Array<{ region: string; county: string; zips: number; path: string; sha256: string }>
}

/**
 * Reads every NAD page once, measures every state's address shapes,
 * keeps a uniform reservoir sample of at most `cap` rows for each requested state,
 * and tallies the majority city of each ZIP in each requested county.
 *
 * The sample is written in reservoir order rather than page order, so a reader that
 * takes the first N rows still draws across the whole state.
 * It refuses to replace a file that already exists.
 */
export async function buildNADSkeletons(options: BuildNADSkeletonsOptions): Promise<NADSkeletonSummary> {
	const { inputDirectory, cap, seed } = options
	const states = new Set(options.states.map((s) => s.toUpperCase()))

	const outputs = [
		...[...states].map((region) => nadSkeletonFile(region).zip),
		...options.zipCityCounties.map(nadZipCityPath),
	]

	for (const output of outputs) {
		if (await pathExists(output)) throw new Error(`${output} already exists; a skeleton artifact is never replaced`)
	}

	const random = mulberry32(seed)
	const tallies = new Map<string, ShapeTally>()
	const reservoirs = new Map<string, { seen: number; rows: NADSkeletonRow[] }>()
	const zipCity = new Map<string, Map<string, Map<string, number>>>()
	const countyKey = (region: string, county: string) => `${region}|${county.toLowerCase()}`
	const wantedCounties = new Set(options.zipCityCounties.map((c) => countyKey(c.region, c.county)))

	const pages = await Globerator.files("ndjson", { cwd: inputDirectory, absolute: false, recursive: false }).toSorted()

	let pagesRead = 0

	for (const page of pages) {
		for await (const line of TextSpliterator.fromAsync(resolvePathBuilder(inputDirectory, page))) {
			if (!line) continue
			const record = tryParsingJSON<NADRecord>(line)

			if (!record) continue
			const row = nadSkeletonRow(record)

			if (!row) continue

			let tally = tallies.get(row.REGION)

			if (!tally) {
				tallies.set(row.REGION, (tally = newTally()))
			}

			tallyShape(tally, record, row)

			if (states.has(row.REGION)) {
				let reservoir = reservoirs.get(row.REGION)

				if (!reservoir) {
					reservoirs.set(row.REGION, (reservoir = { seen: 0, rows: [] }))
				}

				reservoir.seen++

				if (reservoir.rows.length < cap) {
					reservoir.rows.push(row)
				} else {
					const slot = Math.floor(random() * reservoir.seen)

					if (slot < cap) {
						reservoir.rows[slot] = row
					}
				}
			}

			const key = countyKey(row.REGION, row.DISTRICT)

			if (wantedCounties.has(key)) {
				let byZip = zipCity.get(key)

				if (!byZip) {
					zipCity.set(key, (byZip = new Map()))
				}

				let byCity = byZip.get(row.POSTCODE)

				if (!byCity) {
					byZip.set(row.POSTCODE, (byCity = new Map()))
				}

				byCity.set(row.CITY, (byCity.get(row.CITY) ?? 0) + 1)
			}
		}

		options.onPage?.(++pagesRead, pages.length)
	}

	const summary: NADSkeletonSummary = {
		pages: pages.length,
		cap,
		seed,
		shapes: [...tallies].map(([region, t]) => shapeOf(region, t)).toSorted((a, b) => b.usable - a.usable),
		samples: [],
		zipCity: [],
	}

	for (const region of states) {
		const reservoir = reservoirs.get(region)

		if (!reservoir?.rows.length) throw new Error(`NAD holds no usable row for ${region}`)
		const { zip, csv } = nadSkeletonFile(region)

		const body = [
			NAD_SKELETON_COLUMNS.join(","),
			...reservoir.rows.map((row) => NAD_SKELETON_COLUMNS.map((column) => csvCell(row[column])).join(",")),
			"",
		].join("\n")

		const archive = new ADMZip()

		archive.addFile(csv, Buffer.from(body, "utf8"))
		await writeLocalBuffer(archive.toBuffer(), zip)
		summary.samples.push({ region, rows: reservoir.rows.length, zip: String(zip), csv, csvSHA256: sha256Hex(body) })
	}

	for (const county of options.zipCityCounties) {
		const byZip = zipCity.get(countyKey(county.region, county.county))

		if (!byZip?.size) throw new Error(`NAD holds no usable row for ${county.county} County, ${county.region}`)
		const lines = ["ZIP,CITY,ROWS"]

		for (const [zip, byCity] of [...byZip].toSorted(([a], [b]) => a.localeCompare(b))) {
			const [city, rows] = [...byCity].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!

			lines.push([zip, csvCell(city), String(rows)].join(","))
		}

		const body = `${lines.join("\n")}\n`
		const path = nadZipCityPath(county)

		await writeLocalTextFile(body, path)
		summary.zipCity.push({ ...county, zips: byZip.size, path: String(path), sha256: sha256Hex(body) })
	}

	return summary
}

/**
 * Writes the summary beside the skeletons it describes.
 */
export function writeNADSkeletonSummary(summary: NADSkeletonSummary, path: PathBuilderLike): Promise<void> {
	return writeLocalJSONFile(summary, path)
}
