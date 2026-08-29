/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a PFX1 postcode-prefix index (postcode-structure arc, B3-1) from a postcode SHARD. The
 *   format — writer and reader both — lives in `@mailwoman/neural/postcode-prefix-index`; this
 *   module is only the extraction: group a shard's unit postcodes by prefix, measure each group's
 *   dispersion, and attach the admin ancestry the prefix asserts.
 *
 *   ## The prefix rule, and the trap it walks around
 *
 *   A GB outward code is "the compact form minus its last three characters", NEVER a greedy
 *   `^([A-Z]{1,2}\d{1,2})`. The greedy form reads `BT4 1NY` as district `BT41`, which deletes BT1–BT9
 *   from a census and invents nine districts that do not exist. That is a measured trap, not a
 *   hypothetical: the arc's M-2b measurement hit it first. {@link outwardOf} is the one place the
 *   rule lives.
 *
 *   ## Why the coordinate policy is DERIVED, not passed in
 *
 *   A prefix centroid is only honest when the shard enumerates that prefix's units COMPLETELY.
 *   Over a partial shard the centroid and its `radiusP95Km` describe the SAMPLE — and the sample is
 *   whatever a volunteer mapper happened to attest, which is not a random draw from the district.
 *   The receipt is Northern Ireland: `postalcode-ni-osm.db` covers 9.5% of live NI postcodes, and its
 *   thinnest districts land BT68 at 4 observed units with a sampled p95 radius of 0.27 km — a number
 *   that would tell a consumer the whole district fits in a 270 m circle.
 *
 *   So the builder reads the shard's OWN coverage declaration rather than trusting a flag: a shard
 *   that publishes a `coverage_meaning_of_zero` meta key is declaring itself partial (that key is the
 *   repo's marker for "a miss here means NOT ATTESTED"), and a partial shard gets the ANCESTRY-ONLY
 *   tier — nodes with ancestors, `unitCount`, and no coordinate at all. `postalcode-gb-codepoint.db`
 *   carries no such key (it is one row per unit postcode, straight off the register), so it gets
 *   centroids. There is deliberately no option to override this either way: the tier is a property of
 *   the source, and a flag would let a caller assert precision the data cannot back.
 *
 *   ## Ancestry
 *
 *   Neither postcode shard carries admin ancestry — `spr.parent_id` is `-1` and the `ancestors` table
 *   holds a self-row only, in BOTH. GB ancestry therefore comes from the Royal Mail AREA→constituent
 *   country table in `@mailwoman/codex/gb` joined to the WOF admin DB for the IDs. The two areas the
 *   codex documents as majority calls across a national border (TD, SY —
 *   `GB_BORDER_STRADDLING_AREAS`) assert the United Kingdom and nothing finer, because at OUTWARD
 *   granularity "mostly Scotland" is not something a node may state as fact.
 *
 *   ## The US arm answers a different question, because it has a different problem
 *
 *   `postalcode-us.db` has NO `meta` table, so the coverage rule above cannot run — and inferring
 *   "complete" from a table that does not exist is the meaning-of-zero error the rule was written to
 *   avoid. The US arm therefore never consults it. Its shard is a per-unit enumeration (42,318
 *   distinct names over 42,319 rows), so thin sampling is not the failure mode; contaminated
 *   COORDINATES are, and unlike thin sampling they have a computable signature:
 *
 *   - 414 units sit on null island;
 *   - 1,662 sit on a PLACEHOLDER — a coordinate shared by units from different prefixes. One point
 *       carries 48 codes across 29 unrelated SCFs. Against the ZIP numbering plan as an independent
 *       witness, 65.6% of units whose gazetteer state is contradicted sit on a placeholder, against
 *       4.5% of those that agree: a 14.5× enrichment;
 *   - 6 rows are not postcodes at all. `Lea County-Zip Franklin Memorial Airport` carries a real New
 *       Mexico coordinate and would otherwise mint a prefix `LEA`.
 *
 *   So the US arm excludes those 2,082 units and computes the centroid and its `radiusP95Km` over the
 *   40,243 that remain. What survives is priced rather than trimmed: Alaska's 995/996/997 report
 *   p95 radii of 614–1,030 km, which is not contamination — that is the size of an Alaskan mail
 *   catchment, and a consumer reading 1,030 km learns exactly what the prefix is worth.
 *
 *   ## Why US ancestry is point-in-polygon, not a gazetteer join
 *
 *   Both are available and they disagree. Graded against the ZIP numbering plan — the first digit is
 *   assigned geographically, so a `5xxxx` code cannot be in New York whatever a parent row says —
 *   WOF parentage contradicts it on 8.46% of placed units and point-in-polygon on 0.69%. PIP also
 *   needs no licensed USPS product, which a delivery-area boundary otherwise would.
 *
 *   A prefix asserts its region only when EVERY clean unit under it lands in the same one. That is
 *   GB's border-straddle rule under a different name: 25 SCFs span two or three states and assert the
 *   country alone. Twenty-four of those pair adjacent states (035 ME/NH, 205 DC/MD/VA, 576 ND/SD);
 *   the twenty-fifth, 602, splits IL/NY on the strength of one unit — `60290`, a Chicago code the
 *   shard places near Rochester. The unanimity rule catches it without knowing why, which is the
 *   point of preferring a rule that needs no exception list.
 */

import { GB_BORDER_STRADDLING_AREAS, countryOfPostcodeArea, type UkCountryCode } from "@mailwoman/codex/gb"
import { isZipCode } from "@mailwoman/codex/us"
import { percentile } from "@mailwoman/core/utils"
import type { PostcodePrefixAncestor, PostcodePrefixNode } from "@mailwoman/neural/postcode-prefix-index"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { AdminLocator } from "./admin-locator.ts"

/**
 * Prefix granularity a build extracts. `"outward"` is the GB/NI outward code (area + district); the digit levels are
 * for the fixed-width numeric systems (US 3-digit sectional centre). The value is written to the header's `levels`.
 */
export type PostcodePrefixLevel = "outward" | "3"

/**
 * Coordinate tier of a build. `"centroid"` ships a centroid plus its measured `radiusP95Km`; `"ancestry-only"` ships
 * neither, and that absence is the artifact's honest statement that the source cannot place the prefix.
 */
export type PostcodePrefixCoordinateTier = "centroid" | "ancestry-only"

export interface BuildPostcodePrefixOptions {
	/**
	 * Postcode shard to read — one row per unit postcode in `spr` with `placetype = 'postalcode'`.
	 */
	sourcePath: string
	/**
	 * WOF admin DB the ancestry IDs are resolved from.
	 */
	adminPath: string
	/**
	 * ISO country code (lowercase) the prefixes belong to.
	 */
	country: string
	level: PostcodePrefixLevel
	/**
	 * WOF polygon DB the US arm tests region containment against. Required for `country: "us"`, unused elsewhere — GB
	 * ancestry comes from a documented area table, not from geometry.
	 */
	polygonPath?: string
}

export interface BuildPostcodePrefixResult {
	nodes: PostcodePrefixNode[]
	/**
	 * The shard's `meta` table, verbatim — the command reads `source`, `attribution`, `tier` and the coverage keys out of
	 * it rather than re-deriving prose the shard already wrote about itself.
	 */
	meta: Record<string, string>
	/**
	 * Unit rows read from `spr`.
	 */
	unitRows: number
	/**
	 * Rows whose `name` was too short to cleave a prefix from. Reported rather than silently dropped.
	 */
	skippedShort: number
	coordinateTier: PostcodePrefixCoordinateTier
	/**
	 * Why {@link BuildPostcodePrefixResult.coordinateTier} is what it is, in one sentence, for the build log.
	 */
	coordinateTierReason: string
	/**
	 * True when the shard declares itself a partial enumeration (`coverage_meaning_of_zero` present).
	 */
	partialSource: boolean
	/**
	 * Prefixes whose constituent-country ancestry was WITHHELD because their postcode area straddles a national border.
	 */
	borderStraddlingPrefixes: string[]
	/**
	 * Per-prefix `radiusP95Km`, in node order — the round-trip check medians this and compares it against M-2.
	 */
	radiiP95Km: number[]
	/**
	 * Units the US arm dropped because their coordinate is not a location, by reason. Empty on the GB arm, which drops
	 * none. Reported rather than folded into {@link BuildPostcodePrefixResult.skippedShort}: "the name was too short to
	 * cleave" and "the name was a place, not a postcode" are different source defects and a build log that conflated them
	 * would hide one behind the other.
	 */
	excludedUnits: Readonly<Record<string, number>>
	/**
	 * Units that reached a node's `unitCount`. Reported rather than left for the caller to derive: which exclusions
	 * happen before a group exists and which after is an internal detail of each arm, and a round-trip check that
	 * re-derived it from `unitRows` minus a subset of the reasons would break the next time an arm adds one.
	 */
	indexedUnits: number
}

interface AdminSurfaceRow {
	id: number
	name: string
}

/**
 * Shortest compact UK postcode, `M11AE` — the same floor `codex/gb/postcode.ts`'s `MIN_POSTCODE_LENGTH` enforces.
 * Anything shorter has no three-character inward code to cleave off, so it yields no outward at all.
 */
const MIN_COMPACT_POSTCODE_LENGTH = 5

/**
 * The outward code of a compact unit postcode: everything but the last three characters. See the module docstring for
 * why this is not a regex.
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
 * WOF names of the four UK constituent countries, keyed by the codex's `UkCountryCode`. They are `macroregion`s in WOF,
 * not `region`s — the `region` tier under GB is the ~200 unitary authorities and council areas.
 */
const UK_COUNTRY_WOF_NAME: Record<UkCountryCode, string> = {
	ENG: "England",
	SCT: "Scotland",
	WLS: "Wales",
	NIR: "Northern Ireland",
}

/**
 * Resolve the GB admin surfaces a postcode-area assertion needs: the United Kingdom itself plus the four constituent
 * countries. Throws when one is missing — a build that silently dropped an ancestor would ship nodes asserting less
 * than the source supports, and nothing downstream could tell that from a prefix that genuinely asserts nothing.
 */
function resolveGBAncestry(adminPath: string): {
	country: PostcodePrefixAncestor
	constituent: Record<UkCountryCode, PostcodePrefixAncestor>
} {
	const db = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })

	try {
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
	} finally {
		db.destroy()
	}
}

/**
 * Read a shard's `meta` table into a plain record.
 */
function readMeta(db: DatabaseClient<WOFDatabase>): Record<string, string> {
	const hasMeta =
		db.prepare(`select name from sqlite_master where type = 'table' and name = 'meta'`).get() !== undefined

	// A shard with no `meta` table has made no declaration, which is NOT the same as declaring itself complete. The GB
	// coverage rule keys off the ABSENCE of one specific key, so it can only be applied to a shard that has the table to
	// be missing a key from; `postalcode-us.db` does not, and the US arm never asks.
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
 * Group a postcode shard's units by prefix and build the PFX1 node table.
 */
export function buildPostcodePrefixIndex(options: BuildPostcodePrefixOptions): BuildPostcodePrefixResult {
	const { sourcePath, adminPath, country, level } = options

	if (country === "us") return buildUSPostcodePrefixIndex(options)

	if (country !== "gb") {
		throw new Error(
			`postcode-prefix: no ancestry rule for country "${country}". GB and US are implemented; a new one needs a ` +
				`stated rule for what a prefix may assert, not just a shard.`
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

		const node: PostcodePrefixNode = { prefix, ancestors, unitCount: members.length }

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
 * Centroid of a prefix's clean unit coordinates, with the p95 great-circle distance from it — the pair PFX1 requires
 * together. Mean-of-points, not a bounding-box centre: a prefix is a set of delivery points, and the mean is where they
 * are, while a bbox centre is a corner artefact of the two extremes.
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
	 * Every unit under the prefix, including the ones excluded from the coordinate — `unitCount` states what the source
	 * enumerates, which is a claim about the postal system rather than about our coordinate hygiene.
	 */
	units: number
	clean: Array<readonly [number, number]>
	regionsSeen: Map<string, PostcodePrefixAncestor>
}

/**
 * The US 3-digit (sectional centre) arm. See the module docstring for why its exclusions and its ancestry rule differ
 * from GB's.
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

	// A coordinate carrying units from DIFFERENT prefixes is a placeholder the source reached for when it had no
	// location — never a real one, since two sectional centres do not share a point. Units of the SAME prefix sharing a
	// point are ordinary (a city's PO-box codes all sit downtown), so the test is deliberately cross-prefix only.
	const byCoordinate = new Map<string, Set<string>>()

	for (const row of rows) {
		// A row that is not a postcode has no prefix to contribute, and letting one vote would mark a real unit sharing
		// its coordinate as a placeholder — the shape guard below has to run first here too.
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
		// The shape guard, not a length check: six rows in the shipped shard are PLACE NAMES that reached a postcode
		// table, and one of them ("Lea County-Zip Franklin Memorial Airport") carries a real coordinate.
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

		const node: PostcodePrefixNode = { prefix, ancestors, unitCount: group.units }

		if (group.clean.length) {
			const { lat, lon, radiusP95Km } = centroidWithRadius(group.clean)

			node.lat = lat
			node.lon = lon
			node.radiusP95Km = radiusP95Km
			radiiP95Km.push(radiusP95Km)
		}

		nodes.push(node)
	}

	const withCoordinate = nodes.filter((node) => node.lat !== undefined).length

	return {
		nodes,
		meta,
		unitRows: rows.length,
		skippedShort,
		coordinateTier: "centroid",
		coordinateTierReason:
			`the shard declares no coverage (it carries no meta table), so the declaration rule cannot be applied and is ` +
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
 * The WOF `country` row a US prefix asserts. Every code here is USPS-issued, so the country holds even for the
 * territories WOF models as countries of their own — the assertion is about postal jurisdiction, and nothing finer is
 * claimed for them because their units land in no US region polygon.
 */
function resolveUSCountry(adminPath: string): PostcodePrefixAncestor {
	const db = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })

	try {
		const row = db.prepare(`select id, name from spr where country = 'US' and placetype = 'country' limit 1`).get() as
			| AdminSurfaceRow
			| undefined

		if (!row) throw new Error(`postcode-prefix: no US country row in ${adminPath}`)

		return { placetype: "country", wofID: row.id, name: row.name }
	} finally {
		db.destroy()
	}
}
