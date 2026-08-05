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
 */

import { DatabaseSync } from "node:sqlite"

import { GB_BORDER_STRADDLING_AREAS, countryOfPostcodeArea, type UkCountryCode } from "@mailwoman/codex/gb"
import { percentile } from "@mailwoman/core/utils"
import type { PostcodePrefixAncestor, PostcodePrefixNode } from "@mailwoman/neural/postcode-prefix-index"
import { haversineKm } from "@mailwoman/spatial"

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
	const db = new DatabaseSync(adminPath, { readOnly: true })

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
		db.close()
	}
}

/**
 * Read a shard's `meta` table into a plain record.
 */
function readMeta(db: DatabaseSync): Record<string, string> {
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

	if (country !== "gb") {
		throw new Error(
			`postcode-prefix: no ancestry rule for country "${country}". GB is the only one implemented (B3-1 scope); ` +
				`the US 3-digit tier is B3-4 and needs a ZCTA acquisition, not a gazetteer join — see M-3's firm-ZIP finding.`
		)
	}

	const db = new DatabaseSync(sourcePath, { readOnly: true })

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
		db.close()
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
	}
}
