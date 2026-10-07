/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a PFX1 postcode-prefix index from a postcode database.
 *   Group unit postcodes by prefix. Measure each group's dispersion and attach the admin ancestry the prefix asserts.
 *
 *   A GB outward code is the compact form minus its last three characters, never a greedy
 *   `^([A-Z]{1,2}\d{1,2})`; {@link outwardOf} is the one place the rule lives.
 *
 *   A database that publishes a `coverage_meaning_of_zero` meta key declares itself partial and gets
 *   the ancestry-only tier, because a centroid over a partial enumeration describes the sample rather
 *   than the prefix. The tier is a property of the source and is deliberately not overridable.
 *
 *   The US arm asserts a region by point-in-polygon under a unanimity rule, because a WOF gazetteer
 *   join contradicts the ZIP numbering plan more often.
 */

import { GB_BORDER_STRADDLING_AREAS, countryOfPostcodeArea, type UkCountryCode } from "@mailwoman/codex/gb"
import { isZipCode } from "@mailwoman/codex/us"
import type { PostcodePrefixAncestor, PostcodePrefixNode } from "@mailwoman/core/resolver"
import { percentile } from "@mailwoman/core/stats"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { AdminLocator } from "#gazetteer/admin/locator"

/**
 * Prefix granularity a build extracts.
 *
 * `"outward"` is the GB/NI outward code (area + district); the digit levels are for
 * the fixed-width numeric systems (US 3-digit sectional center).
 * Written to the header's `levels`.
 */
export type PostcodePrefixLevel = "outward" | "3"

/**
 * Coordinate tier of a build.
 *
 * `"centroid"` ships a centroid plus its measured `radiusP95Km`; `"ancestry-only"` ships neither.
 * This tier states that the source cannot place the prefix.
 */
export type PostcodePrefixCoordinateTier = "centroid" | "ancestry-only"

export interface BuildPostcodePrefixOptions {
	/**
	 * Postcode database to read — one row per unit postcode in `spr` with `placetype = 'postalcode'`.
	 */
	sourcePath: PathBuilderLike
	/**
	 * WOF admin DB the ancestry IDs are resolved from.
	 */
	adminPath: PathBuilderLike
	/**
	 * ISO country code (lowercase) the prefixes belong to.
	 */
	country: string
	level: PostcodePrefixLevel
	/**
	 * WOF polygon DB the US arm tests region containment against.
	 * Required for `country: "us"`.
	 *
	 * GB ancestry comes from a documented area table rather than from geometry.
	 */
	polygonPath?: PathBuilderLike
}

export interface BuildPostcodePrefixResult {
	nodes: PostcodePrefixNode[]
	/**
	 * The database's `meta` table, verbatim.
	 *
	 * The command reads `source`, `attribution`, `tier` and the coverage keys out of it
	 * rather than re-deriving prose the database already wrote about itself.
	 */
	meta: Record<string, string>
	/**
	 * Unit rows read from `spr`.
	 */
	unitRows: number
	/**
	 * Rows whose `name` was too short to cleave a prefix from.
	 * Reported rather than dropped.
	 */
	skippedShort: number
	coordinateTier: PostcodePrefixCoordinateTier
	/**
	 * Why {@link BuildPostcodePrefixResult.coordinateTier} is what it is, in one sentence, for the build log.
	 */
	coordinateTierReason: string
	/**
	 * True when the database declares itself a partial enumeration (`coverage_meaning_of_zero` present).
	 */
	partialSource: boolean
	/**
	 * Prefixes whose constituent-country ancestry was withheld because their
	 * postcode area straddles a national border.
	 */
	borderStraddlingPrefixes: string[]
	/**
	 * Per-prefix `radiusP95Km`, in node order.
	 */
	radiiP95Km: number[]
	/**
	 * Units the US arm dropped because their coordinate is not a location, by reason.
	 *
	 * The GB arm drops no units, so this record is empty for that arm.
	 * Reported separately from {@link BuildPostcodePrefixResult.skippedShort}
	 * because the two are different source defects.
	 */
	excludedUnits: Readonly<Record<string, number>>
	/**
	 * Units that reached a node's `unitCount`.
	 *
	 * Reported rather than left for the caller to derive, since which exclusions happen
	 * before a group exists is an internal detail of each arm.
	 */
	indexedUnits: number
}

interface AdminSurfaceRow {
	id: number
	name: string
}

/**
 * Shortest compact UK postcode, `M11AE` — the same floor `codex/gb/postcode.ts`'s
 * `MIN_POSTCODE_LENGTH` enforces.
 *
 * Anything shorter has no three-character inward code to cleave off.
 */
const MIN_COMPACT_POSTCODE_LENGTH = 5

/**
 * The outward code of a compact unit postcode: everything but the last three characters.
 *
 * See the module docstring for why this is not a regex.
 */
export function outwardOf(compact: string): string | null {
	if (compact.length < MIN_COMPACT_POSTCODE_LENGTH) return null

	return compact.slice(0, -3)
}

function prefixOf(compact: string, level: PostcodePrefixLevel): string | null {
	if (level === "outward") return outwardOf(compact)

	const width = Number.parseInt(level, 10)

	return compact.length >= width ? compact.slice(0, width) : null
}

/**
 * WOF names of the four UK constituent countries, keyed by the codex's `UkCountryCode`.
 *
 * WOF records them as `macroregion`s.
 * The `region` tier under GB is the ~200 unitary authorities and council areas.
 */
const UK_COUNTRY_WOF_NAME: Record<UkCountryCode, string> = {
	ENG: "England",
	SCT: "Scotland",
	WLS: "Wales",
	NIR: "Northern Ireland",
}

/**
 * Resolve the GB admin surfaces a postcode-area assertion needs: the United Kingdom
 * itself plus the four constituent countries.
 *
 * @throws When one is missing.
 * A silently dropped ancestor would ship nodes asserting less than the source supports,
 * indistinguishable to a reader from a prefix that asserts no fact.
 */
function resolveGBAncestry(adminPath: PathBuilderLike): {
	country: PostcodePrefixAncestor
	constituent: Record<UkCountryCode, PostcodePrefixAncestor>
} {
	using db = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })

	const countryRow = db
		.prepare(`select id, name from spr where country = 'GB' and placetype = 'country' limit 1`)
		.get() as AdminSurfaceRow | undefined

	if (!countryRow) {
		throw new Error(`postcode-prefix: no GB country row in ${adminPath}`)
	}

	const stmt = db.prepare(`select id, name from spr where country = 'GB' and placetype = 'macroregion' and name = ?`)
	const constituent = {} as Record<UkCountryCode, PostcodePrefixAncestor>

	for (const [code, name] of Object.entries(UK_COUNTRY_WOF_NAME) as Array<[UkCountryCode, string]>) {
		const row = stmt.get(name) as AdminSurfaceRow | undefined

		if (!row) {
			throw new Error(`postcode-prefix: no GB macroregion named "${name}" in ${adminPath}`)
		}

		constituent[code] = { placetype: "macroregion", wofID: row.id, name: row.name }
	}

	return {
		country: { placetype: "country", wofID: countryRow.id, name: countryRow.name },
		constituent,
	}
}

/**
 * Read a database's `meta` table into a plain record.
 */
function readMeta(db: DatabaseClient<WOFDatabase>): Record<string, string> {
	const hasMeta =
		db.prepare(`select name from sqlite_master where type = 'table' and name = 'meta'`).get() !== undefined

	// A database with no `meta` table has made no declaration.
	// The US arm never asks for one in `postalcode-us.db`.
	if (!hasMeta) return {}

	const rows = db.prepare(`select key, value from meta`).all() as Array<{ key: string; value: string | null }>
	const meta: Record<string, string> = {}

	for (const row of rows) {
		if (typeof row.value === "string") {
			meta[row.key] = row.value
		}
	}

	return meta
}

/**
 * Group a postcode database's units by prefix and build the PFX1 node table.
 */
export function buildPostcodePrefixIndex(options: BuildPostcodePrefixOptions): BuildPostcodePrefixResult {
	const { sourcePath, adminPath, country, level } = options

	if (country === "us") return buildUSPostcodePrefixIndex(options)

	if (country !== "gb") {
		throw new Error(
			`postcode-prefix: no ancestry rule for country "${country}". GB and US are implemented; a new one needs a ` +
				`stated rule for what a prefix may assert rather than just a database.`
		)
	}

	const db = new DatabaseClient<WOFDatabase>(sourcePath, { readOnly: true })

	let meta: Record<string, string>
	let rows: Array<{ name: string; latitude: number; longitude: number }>

	try {
		meta = readMeta(db)

		rows = db.prepare(`select name, latitude, longitude from spr where placetype = 'postalcode'`).all() as Array<{
			name: string
			latitude: number
			longitude: number
		}>
	} finally {
		db.destroy()
	}

	const partialSource = "coverage_meaning_of_zero" in meta

	const coordinateTier: PostcodePrefixCoordinateTier = partialSource ? "ancestry-only" : "centroid"

	const coordinateTierReason = partialSource
		? `source declares coverage_meaning_of_zero — a partial enumeration, so a prefix centroid would describe the ` +
			`sample and its radiusP95Km would understate the prefix by an unmeasured factor`
		: "source is a complete per-unit enumeration (no coverage_meaning_of_zero declaration)"

	const groups = new Map<string, Array<[number, number]>>()
	let skippedShort = 0

	for (const row of rows) {
		const compact = row.name.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase()
		const prefix = prefixOf(compact, level)

		if (!prefix) {
			skippedShort++

			continue
		}

		let bucket = groups.get(prefix)

		if (!bucket) {
			bucket = []
			groups.set(prefix, bucket)
		}

		bucket.push([row.latitude, row.longitude])
	}

	const { country: ukAncestor, constituent } = resolveGBAncestry(adminPath)
	const nodes: PostcodePrefixNode[] = []
	const borderStraddlingPrefixes: string[] = []
	const radiiP95Km: number[] = []

	for (const [prefix, members] of groups) {
		const area = /^[A-Z]{1,2}/.exec(prefix)?.[0] ?? ""
		const straddles = GB_BORDER_STRADDLING_AREAS.has(area)
		const constituentCode = straddles ? null : countryOfPostcodeArea(area)

		const ancestors: PostcodePrefixAncestor[] = [ukAncestor]

		if (constituentCode) {
			ancestors.push(constituent[constituentCode])
		} else {
			borderStraddlingPrefixes.push(prefix)
		}

		const node: PostcodePrefixNode = {
			prefix,
			ancestors,
			lat: null,
			lon: null,
			radiusP95Km: null,
			unitCount: members.length,
		}

		if (coordinateTier === "centroid") {
			let sumLat = 0
			let sumLon = 0

			for (const [lat, lon] of members) {
				sumLat += lat
				sumLon += lon
			}

			const lat = sumLat / members.length
			const lon = sumLon / members.length
			const distances = members.map(([mLat, mLon]) => haversineKm(lat, lon, mLat, mLon))
			const radiusP95Km = percentile(distances, 95)!

			node.lat = lat
			node.lon = lon
			node.radiusP95Km = radiusP95Km
			radiiP95Km.push(radiusP95Km)
		}

		nodes.push(node)
	}

	return {
		nodes,
		meta,
		unitRows: rows.length,
		skippedShort,
		coordinateTier,
		coordinateTierReason,
		partialSource,
		borderStraddlingPrefixes,
		radiiP95Km,
		excludedUnits: {},
		indexedUnits: rows.length - skippedShort,
	}
}

/**
 * Centroid of a prefix's clean unit coordinates, with the p95 great-circle distance
 * from it — the pair PFX1 requires together.
 *
 * Mean-of-points rather than a bounding-box center, because a prefix is a set of delivery
 * points and a bbox center is a corner artifact of the two extremes.
 */
function centroidWithRadius(members: ReadonlyArray<readonly [number, number]>): {
	lat: number
	lon: number
	radiusP95Km: number
} {
	let sumLat = 0
	let sumLon = 0

	for (const [lat, lon] of members) {
		sumLat += lat
		sumLon += lon
	}

	const lat = sumLat / members.length
	const lon = sumLon / members.length

	return {
		lat,
		lon,
		radiusP95Km: percentile(
			members.map(([mLat, mLon]) => haversineKm(lat, lon, mLat, mLon)),
			95
		)!,
	}
}

interface USPrefixGroup {
	/**
	 * Every unit under the prefix, including the ones excluded from the coordinate.
	 *
	 * `unitCount` states what the source enumerates rather than our coordinate hygiene.
	 */
	units: number
	clean: Array<readonly [number, number]>
	regionsSeen: Map<string, PostcodePrefixAncestor>
}

/**
 * The US 3-digit (sectional center) arm.
 *
 * See the module docstring for why its exclusions and ancestry rule differ from GB's.
 */
function buildUSPostcodePrefixIndex(options: BuildPostcodePrefixOptions): BuildPostcodePrefixResult {
	const { sourcePath, adminPath, level } = options
	const polygonPath = options.polygonPath

	if (level !== "3") {
		throw new Error(`postcode-prefix: the US arm indexes the 3-digit sectional centre; got level "${level}".`)
	}

	if (!polygonPath) {
		throw new Error(
			`postcode-prefix: the US arm asserts a region by point-in-polygon and needs polygonPath. A gazetteer join is ` +
				`not a substitute — it contradicts the ZIP numbering plan 12× more often.`
		)
	}

	const db = new DatabaseClient<WOFDatabase>(sourcePath, { readOnly: true })

	let meta: Record<string, string>
	let rows: Array<{ name: string; latitude: number; longitude: number }>

	try {
		meta = readMeta(db)

		rows = db.prepare(`select name, latitude, longitude from spr where placetype = 'postalcode'`).all() as Array<{
			name: string
			latitude: number
			longitude: number
		}>
	} finally {
		db.destroy()
	}

	// A coordinate carrying units from different prefixes is a placeholder,
	// never a real one, since two sectional centers do not share a point. same-prefix
	// sharing is ordinary and deliberately not excluded.
	const byCoordinate = new Map<string, Set<string>>()

	for (const row of rows) {
		// A non-postcode row has no prefix to contribute.
		// A non-postcode row would mark a real unit sharing its coordinate as a placeholder if it voted.
		if (!isZipCode(row.name)) continue

		if (row.latitude === 0 && row.longitude === 0) continue

		const key = `${row.latitude.toFixed(4)},${row.longitude.toFixed(4)}`
		const seen = byCoordinate.get(key)

		if (seen) {
			seen.add(row.name.slice(0, 3))
		} else {
			byCoordinate.set(key, new Set([row.name.slice(0, 3)]))
		}
	}

	const locator = new AdminLocator({ adminPath, polygonPath, placetype: "region", country: "US" })
	const groups = new Map<string, USPrefixGroup>()
	const excluded = { notAPostcode: 0, nullIsland: 0, placeholderCoordinate: 0, outsideEveryRegion: 0 }
	let skippedShort = 0

	for (const row of rows) {
		// Use a shape guard rather than a length check.
		// Place names reach a postcode table.
		// At least one of those names has a real coordinate.
		if (!isZipCode(row.name)) {
			excluded.notAPostcode++

			continue
		}

		const prefix = prefixOf(row.name.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase(), level)

		if (!prefix) {
			skippedShort++

			continue
		}

		let group = groups.get(prefix)

		if (!group) {
			group = { units: 0, clean: [], regionsSeen: new Map() }
			groups.set(prefix, group)
		}

		group.units++

		if (row.latitude === 0 && row.longitude === 0) {
			excluded.nullIsland++

			continue
		}

		const sharedBy = byCoordinate.get(`${row.latitude.toFixed(4)},${row.longitude.toFixed(4)}`)

		if (sharedBy && sharedBy.size > 1) {
			excluded.placeholderCoordinate++

			continue
		}

		group.clean.push([row.latitude, row.longitude])

		const region = locator.locate(row.longitude, row.latitude)

		if (region) {
			group.regionsSeen.set(region.name, { placetype: region.placetype, wofID: region.id, name: region.name })
		} else {
			excluded.outsideEveryRegion++
		}
	}

	const countryAncestor = resolveUSCountry(adminPath)
	const nodes: PostcodePrefixNode[] = []
	const radiiP95Km: number[] = []
	const straddling: string[] = []

	for (const [prefix, group] of [...groups].toSorted(([a], [b]) => a.localeCompare(b))) {
		const ancestors: PostcodePrefixAncestor[] = [countryAncestor]
		const unanimous = group.regionsSeen.size === 1 ? [...group.regionsSeen.values()][0] : undefined

		if (unanimous) {
			ancestors.push(unanimous)
		} else if (group.regionsSeen.size > 1) {
			straddling.push(prefix)
		}

		const node: PostcodePrefixNode = {
			prefix,
			ancestors,
			lat: null,
			lon: null,
			radiusP95Km: null,
			unitCount: group.units,
		}

		if (group.clean.length) {
			const { lat, lon, radiusP95Km } = centroidWithRadius(group.clean)

			node.lat = lat
			node.lon = lon
			node.radiusP95Km = radiusP95Km
			radiiP95Km.push(radiusP95Km)
		}

		nodes.push(node)
	}

	const withCoordinate = nodes.filter((node) => node.lat !== null).length

	return {
		nodes,
		meta,
		unitRows: rows.length,
		skippedShort,
		coordinateTier: "centroid",
		coordinateTierReason:
			`the database declares no coverage (it carries no meta table), so the declaration rule cannot be applied and is ` +
			`not guessed at; instead ${(excluded.nullIsland + excluded.placeholderCoordinate).toLocaleString()} units whose ` +
			`coordinate is demonstrably not a location were excluded, and ${withCoordinate} of ${nodes.length} prefixes ` +
			`carry a centroid priced by its own radiusP95Km`,
		partialSource: false,
		borderStraddlingPrefixes: straddling,
		radiiP95Km,
		excludedUnits: excluded,
		indexedUnits: nodes.reduce((sum, node) => sum + node.unitCount, 0),
	}
}

/**
 * The WOF `country` row a US prefix asserts.
 *
 * Every code here is USPS-issued, so the country holds even for territories
 * WOF models as countries of their own.
 * No finer unit is claimed because their units land in no US region polygon.
 */
function resolveUSCountry(adminPath: PathBuilderLike): PostcodePrefixAncestor {
	using db = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })

	const row = db.prepare(`select id, name from spr where country = 'US' and placetype = 'country' limit 1`).get() as
		| AdminSurfaceRow
		| undefined

	if (!row) throw new Error(`postcode-prefix: no US country row in ${adminPath}`)

	return { placetype: "country", wofID: row.id, name: row.name }
}
