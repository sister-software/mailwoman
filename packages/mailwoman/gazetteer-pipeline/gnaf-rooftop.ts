/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `osm/address-points-au-au.db` — the AU rooftop shard from Geoscape G-NAF, on the SHARED
 *   situs schema + OSM H3 spine so the existing `OSMShardProvider` / `AddressPointSqliteLookup`
 *   serve it with zero runtime changes.
 *
 *   WHY G-NAF and not OSM for AU: the panel's en-AU misses were uniformly `tier=admin` at 1–6 km —
 *   correct locality centroids with no address point to snap to. G-NAF is the authoritative
 *   national register (~15M principal addresses including rural LOT numbering), CC-BY-4.0 with
 *   attribution — no ODbL posture, unlike the OSM-derived siblings in the same directory. The
 *   acquisition provenance (EULA, use-restriction fact sheet, sha256) lives beside the source data
 *   under `<data-root>/gnaf/<release>/PROVENANCE.md`.
 *
 *   JOIN SHAPE (per state, streaming): `LOCALITY` (pid → name) and `STREET_LOCALITY` (pid →
 *   name/type/suffix) load as maps; `ADDRESS_DEFAULT_GEOCODE` (detail-pid → lon/lat) loads as a
 *   map; then `ADDRESS_DETAIL` streams once. Retired rows and non-principal (alias) addresses are
 *   skipped. `NUMBER_FIRST` wins; a number-less row falls back to `LOT_NUMBER` (the `LOT 373`
 *   rural class the parser reads as unit + house_number). Street rendering: `STREET_NAME` +
 *   `STREET_TYPE_CODE` + suffix, with the directional suffix CODES expanded to words (the register
 *   stores types as full words but suffixes as codes); keys via the shared `en` normalizer — the
 *   same branch the GB/NZ shards use.
 *
 *   G-NAF PSV is CRLF-terminated and quote-free: the trailing `\r` must be stripped at the reader
 *   boundary or the LAST column's name and every last-field value carry it — the geocode file's
 *   `LATITUDE` column is last, so the un-stripped join loses every coordinate (the ACT smoke's
 *   0-geocode failure).
 */

import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { LayerFreshnessPolicy, LayerTier, writeLayerManifest } from "@mailwoman/core/layers"
import { dataRootPath, sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/core/utils"
import {
	createOSMAddressPointIndexes,
	createOSMAddressPointTables,
	OSM_ADDRESS_H3_RESOLUTION,
	OSM_ADDRESS_POINT_COLUMNS,
	type OSMAddressPointDatabase,
} from "@mailwoman/osm/sdk"
import { createAddressPointIndexes } from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
} from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"
import { TextSpliterator } from "spliterator"

/**
 * G-NAF `STREET_SUFFIX_CODE` → display word.
 */
const SUFFIX_WORDS = new Map<string, string>([
	["N", "North"],
	["S", "South"],
	["E", "East"],
	["W", "West"],
	["NE", "North East"],
	["NW", "North West"],
	["SE", "South East"],
	["SW", "South West"],
	["CN", "Central"],
	["EX", "Extension"],
	["LR", "Lower"],
	["UP", "Upper"],
])

export interface GNAFRooftopOptions {
	/**
	 * The extracted `Standard/` PSV directory. Default: `<data-root>/gnaf/may26/extracted/G-NAF/G-NAF MAY 2026/Standard`.
	 */
	standardDir?: string
	/**
	 * Output shard path. Default: `<data-root>/osm/address-points-au-au.db` (the `OSMShardProvider` home).
	 */
	out?: string
	/**
	 * Restrict to these state prefixes (e.g. `["ACT"]`) — the smoke rung. Default: every state present.
	 */
	states?: string[]
	/**
	 * The G-NAF release tag written to `release` and the layer manifest.
	 */
	release?: string
	buildSHA: string
	/**
	 * ISO-8601. The builder never invents provenance time.
	 */
	createdAt: string
	log?: (line: string) => void
}

export interface GNAFRooftopResult {
	out: string
	written: number
	retired: number
	alias: number
	noNumber: number
	noGeocode: number
	noStreet: number
}

function stripCR(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line
}

function rowReader(header: string): (line: string) => Record<string, string> {
	const cols = stripCR(header).split("|")

	return (line) => {
		const parts = stripCR(line).split("|")
		const rec: Record<string, string> = {}

		for (let i = 0; i < cols.length; i++) {
			rec[cols[i]!] = parts[i] ?? ""
		}

		return rec
	}
}

function titleCase(s: string): string {
	return s.toLowerCase().replaceAll(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
}

async function loadMap(
	path: string,
	build: (rec: Record<string, string>) => [string, string] | null
): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	let read: ((line: string) => Record<string, string>) | null = null

	for await (const line of TextSpliterator.fromAsync(path)) {
		if (!line) continue

		if (!read) {
			read = rowReader(line)

			continue
		}

		const entry = build(read(line))

		if (entry) {
			map.set(entry[0], entry[1])
		}
	}

	return map
}

export async function buildGNAFRooftopShard(options: GNAFRooftopOptions): Promise<GNAFRooftopResult> {
	const release = options.release ?? "may26-gda2020"

	const standardDir =
		options.standardDir ?? String(dataRootPath("gnaf", "may26", "extracted", "G-NAF", "G-NAF MAY 2026", "Standard"))

	const out = options.out ?? String(dataRootPath("osm", "address-points-au-au.db"))
	const log = options.log ?? (() => {})

	if (!new Date(options.createdAt).toISOString() || new Date(options.createdAt).toISOString() !== options.createdAt) {
		throw new Error("createdAt must be an exact ISO-8601 timestamp")
	}

	const only = options.states ? new Set(options.states.map((s) => s.toUpperCase())) : null

	const states = readdirSync(standardDir)
		.filter((f) => f.endsWith("_ADDRESS_DETAIL_psv.psv"))
		.map((f) => f.replace("_ADDRESS_DETAIL_psv.psv", ""))
		.filter((s) => !only || only.has(s))
		.toSorted()

	if (!states.length) {
		throw new Error(`no G-NAF state files under ${standardDir}`)
	}

	const tmp = `${out}.tmp-${process.pid}`

	if (existsSync(tmp)) {
		rmSync(tmp)
	}

	const db = new DatabaseSync(tmp)

	db.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")
	const kdb = new DatabaseClient<OSMAddressPointDatabase>({ database: db })

	await createOSMAddressPointTables(kdb)

	const insert = db.prepare(`INSERT INTO address_point VALUES (${OSM_ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)
	const counts: GNAFRooftopResult = { out, written: 0, retired: 0, alias: 0, noNumber: 0, noGeocode: 0, noStreet: 0 }
	const BATCH = 50_000

	for (const state of states) {
		const p = (family: string) => join(standardDir, `${state}_${family}_psv.psv`)

		const localities = await loadMap(p("LOCALITY"), (r) =>
			r["LOCALITY_PID"] && r["LOCALITY_NAME"] ? [r["LOCALITY_PID"], r["LOCALITY_NAME"]] : null
		)

		const streets = await loadMap(p("STREET_LOCALITY"), (r) => {
			if (!r["STREET_LOCALITY_PID"] || !r["STREET_NAME"]) return null

			const type = r["STREET_TYPE_CODE"] ? ` ${r["STREET_TYPE_CODE"]}` : ""

			const suffix = r["STREET_SUFFIX_CODE"]
				? ` ${SUFFIX_WORDS.get(r["STREET_SUFFIX_CODE"]) ?? r["STREET_SUFFIX_CODE"]}`
				: ""

			return [r["STREET_LOCALITY_PID"], titleCase(`${r["STREET_NAME"]}${type}${suffix}`)]
		})

		const geocodes = await loadGeocodes(p("ADDRESS_DEFAULT_GEOCODE"))

		log(
			`[gnaf] ${state}: ${localities.size.toLocaleString()} localities, ${streets.size.toLocaleString()} streets, ${geocodes.size.toLocaleString()} geocodes`
		)

		let read: ((line: string) => Record<string, string>) | null = null

		db.exec("BEGIN")

		for await (const line of TextSpliterator.fromAsync(p("ADDRESS_DETAIL"))) {
			if (!line) continue

			if (!read) {
				read = rowReader(line)

				continue
			}

			const r = read(line)

			if (r["DATE_RETIRED"]) {
				counts.retired++

				continue
			}

			if (r["ALIAS_PRINCIPAL"] && r["ALIAS_PRINCIPAL"] !== "P") {
				counts.alias++

				continue
			}

			const streetRaw = streets.get(r["STREET_LOCALITY_PID"] ?? "")

			if (!streetRaw) {
				counts.noStreet++

				continue
			}

			const number = (
				r["NUMBER_FIRST"]
					? `${r["NUMBER_FIRST_PREFIX"] ?? ""}${r["NUMBER_FIRST"]}${r["NUMBER_FIRST_SUFFIX"] ?? ""}`
					: `${r["LOT_NUMBER_PREFIX"] ?? ""}${r["LOT_NUMBER"] ?? ""}${r["LOT_NUMBER_SUFFIX"] ?? ""}`
			)
				.trim()
				.toLowerCase()

			if (!number) {
				counts.noNumber++

				continue
			}

			const geo = geocodes.get(r["ADDRESS_DETAIL_PID"] ?? "")

			if (!geo) {
				counts.noGeocode++

				continue
			}

			const streetNorm = normalizeStreetForKeyLocale(streetRaw, "en")

			if (!streetNorm) {
				counts.noStreet++

				continue
			}

			const unit = (
				r["FLAT_NUMBER"] ? `${r["FLAT_NUMBER_PREFIX"] ?? ""}${r["FLAT_NUMBER"]}${r["FLAT_NUMBER_SUFFIX"] ?? ""}` : ""
			)
				.trim()
				.toLowerCase()

			const locality = localities.get(r["LOCALITY_PID"] ?? "")
			const [lon, lat] = geo
			const h3Cell = shortCellToInt(latLngToCell(lat, lon, OSM_ADDRESS_H3_RESOLUTION) as H3Cell)

			insert.run(
				streetNorm,
				canonicalizeRouteKey(streetNorm),
				number,
				unit || null,
				r["POSTCODE"]?.trim() || null,
				locality ? normalizeLocalityForKey(locality) : null,
				streetRaw,
				lat,
				lon,
				"gnaf:au",
				release,
				h3Cell
			)

			counts.written++

			if (counts.written % BATCH === 0) {
				db.exec("COMMIT")
				db.exec("BEGIN")

				if (counts.written % 1_000_000 === 0) {
					log(`[gnaf]   ${counts.written.toLocaleString()} written…`)
				}
			}
		}

		db.exec("COMMIT")
	}

	log(`[gnaf] indexing…`)

	await createAddressPointIndexes(kdb)
	await createOSMAddressPointIndexes(kdb)

	await writeLayerManifest(kdb, {
		name: "gnaf-address-points-au-au",
		version: release,
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "CC-BY-4.0",
		attribution: "© Geoscape Australia — G-NAF, CC BY 4.0",
		source: "gnaf:au",
		sourceVintage: release,
		buildCmd: "mailwoman gazetteer build gnaf-rooftop",
		buildSHA: options.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: OSM_ADDRESS_H3_RESOLUTION } },
		createdAt: options.createdAt,
	})

	db.exec("ANALYZE")
	await kdb.destroy()

	swapDatabaseIntoPlace(tmp, out)
	sealDatabase(out)

	return counts
}

async function loadGeocodes(path: string): Promise<Map<string, [number, number]>> {
	const map = new Map<string, [number, number]>()
	let read: ((line: string) => Record<string, string>) | null = null

	for await (const line of TextSpliterator.fromAsync(path)) {
		if (!line) continue

		if (!read) {
			read = rowReader(line)

			continue
		}

		const r = read(line)
		const lon = Number(r["LONGITUDE"])
		const lat = Number(r["LATITUDE"])

		if (r["ADDRESS_DETAIL_PID"] && Number.isFinite(lon) && Number.isFinite(lat)) {
			map.set(r["ADDRESS_DETAIL_PID"], [lon, lat])
		}
	}

	return map
}
