/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures how deep each country's admin-gazetteer coverage reaches on the containment ladder.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { GEONAMES_ID_BASE, OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { DEFAULT_COVERAGE_FLOOR } from "#gazetteer-pipeline/defaults"
import { PLACETYPE_PROJECTION } from "#gazetteer-pipeline/placetype-census"

export { DEFAULT_COVERAGE_FLOOR } from "#gazetteer-pipeline/defaults"

/**
 * The containment rungs from broadest to deepest.
 * Postcode is not a rung.
 */
export const LADDER: readonly ComponentTag[] = [
	"country",
	"region",
	"subregion",
	"locality",
	"dependent_locality",
	"venue",
	"unit",
]

/**
 * The rungs below locality.
 *
 * They count as reached by parent coverage instead of node presence.
 */
export const SUB_LOCALITY_RUNGS: ReadonlySet<ComponentTag> = new Set<ComponentTag>([
	"dependent_locality",
	"venue",
	"unit",
])

/**
 * The locality-class placetypes that serve as parents in coverage calculations.
 */
export const PARENT_PLACETYPES: readonly string[] = ["locality", "localadmin"]

/**
 * Returns the sorted WOF placetypes that `PLACETYPE_PROJECTION` maps to a rung.
 */
export function placetypesForRung(rung: ComponentTag): string[] {
	return Object.entries(PLACETYPE_PROJECTION)
		.filter(([, tag]) => tag === rung)
		.map(([placetype]) => placetype)
		.toSorted()
}

/**
 * One country's measurement at one rung.
 */
export interface RungMeasurement {
	/**
	 * Current, non-deprecated nodes at this rung from all sources.
	 */
	nodes: number
	/**
	 * How many of {@link nodes} come from the Overture backfill, with IDs from
	 * `OVERTURE_ID_BASE` up to `GEONAMES_ID_BASE`.
	 */
	overtureBackfilled: number
	/**
	 * How many of {@link nodes} come from the GeoNames fold, with IDs at or above `GEONAMES_ID_BASE`.
	 */
	geonamesBackfilled: number
	/**
	 * Distinct locality-class parents with at least one descendant at this rung.
	 */
	parentsCovered: number
	/**
	 * {@link parentsCovered} divided by the country's locality-class node count,
	 * or zero when the country has none.
	 */
	parentCoverage: number
}

/**
 * One country's measurements at every rung.
 */
export interface CountryGranularity {
	country: string
	/**
	 * The number of current, non-deprecated `locality` and `localadmin` nodes.
	 * It is the parent-coverage denominator.
	 */
	localityParents: number
	rungs: Partial<Record<ComponentTag, RungMeasurement>>
}

/**
 * Builds a SQL `CASE` expression that maps a placetype column to its rung.
 */
function rungCaseExpression(column: string): string {
	const whens = LADDER.flatMap((rung) =>
		placetypesForRung(rung).map((placetype) => `WHEN '${placetype}' THEN '${rung}'`)
	)

	return `CASE ${column} ${whens.join(" ")} END`
}

/**
 * Returns every placetype that maps to a ladder rung.
 */
function ladderPlacetypes(): string[] {
	return LADDER.flatMap((rung) => placetypesForRung(rung))
}

/**
 * Measures every country's ladder from a read-only admin database.
 */
export function buildGranularityLadder(adminDBPath: PathBuilderLike): CountryGranularity[] {
	using db = new DatabaseClient<WOFDatabase>(adminDBPath, { readOnly: true })

	const placetypeList = ladderPlacetypes()
		.map((placetype) => `'${placetype}'`)
		.join(", ")

	const parentList = PARENT_PLACETYPES.map((placetype) => `'${placetype}'`).join(", ")
	// The columns are qualified because the parent query joins `spr` to itself.
	const live = (alias: string): string => `${alias}.is_current != 0 AND ${alias}.is_deprecated = 0`

	const nodeRows = db
		.prepare(
			`SELECT s.country AS country,
				${rungCaseExpression("s.placetype")} AS rung,
				COUNT(*) AS nodes,
				SUM(CASE WHEN s.id >= ? AND s.id < ? THEN 1 ELSE 0 END) AS overtureBackfilled,
				SUM(CASE WHEN s.id >= ? THEN 1 ELSE 0 END) AS geonamesBackfilled
			 FROM spr s
			 WHERE ${live("s")} AND s.country != '' AND s.placetype IN (${placetypeList})
			 GROUP BY s.country, rung`
		)
		.all(OVERTURE_ID_BASE, GEONAMES_ID_BASE, GEONAMES_ID_BASE) as Array<{
		country: string
		rung: ComponentTag
		nodes: number
		overtureBackfilled: number | null
		geonamesBackfilled: number | null
	}>

	const parentRows = db
		.prepare(
			`SELECT p.country AS country,
				${rungCaseExpression("s.placetype")} AS rung,
				COUNT(DISTINCT p.id) AS parentsCovered
			 FROM spr s
			 JOIN ancestors a ON a.id = s.id
			 JOIN spr p ON p.id = a.ancestor_id
			 WHERE p.placetype IN (${parentList})
			   AND s.placetype IN (${placetypeList})
			   AND s.country = p.country
			   AND s.id != p.id
			   AND ${live("s")}
			   AND ${live("p")}
			 GROUP BY p.country, rung`
		)
		.all() as Array<{ country: string; rung: ComponentTag; parentsCovered: number }>

	const denominatorRows = db
		.prepare(
			`SELECT s.country AS country, COUNT(*) AS localityParents
			 FROM spr s
			 WHERE ${live("s")} AND s.country != '' AND s.placetype IN (${parentList})
			 GROUP BY s.country`
		)
		.all() as Array<{ country: string; localityParents: number }>

	const byCountry = new Map<string, CountryGranularity>()

	const ensure = (country: string): CountryGranularity => {
		const existing = byCountry.get(country)

		if (existing) return existing

		// Every rung starts at zero, because a measured country with no nodes at a rung has a real zero.
		const rungs: Partial<Record<ComponentTag, RungMeasurement>> = {}

		for (const rung of LADDER) {
			rungs[rung] = { nodes: 0, overtureBackfilled: 0, geonamesBackfilled: 0, parentsCovered: 0, parentCoverage: 0 }
		}

		const row: CountryGranularity = { country, localityParents: 0, rungs }

		byCountry.set(country, row)

		return row
	}

	for (const row of denominatorRows) {
		ensure(row.country).localityParents = row.localityParents
	}

	for (const row of nodeRows) {
		if (!row.rung) continue

		const measurement = ensure(row.country).rungs[row.rung]!

		measurement.nodes = row.nodes
		measurement.overtureBackfilled = row.overtureBackfilled ?? 0
		measurement.geonamesBackfilled = row.geonamesBackfilled ?? 0
	}

	for (const row of parentRows) {
		if (!row.rung) continue

		const measurement = ensure(row.country).rungs[row.rung]!

		measurement.parentsCovered = row.parentsCovered
	}

	for (const country of byCountry.values()) {
		for (const rung of LADDER) {
			const measurement = country.rungs[rung]!

			measurement.parentCoverage = country.localityParents ? measurement.parentsCovered / country.localityParents : 0
		}
	}

	return [...byCountry.values()].toSorted((a, b) => a.country.localeCompare(b.country))
}

/**
 * Returns the deepest rung a country reaches, or `null` when it reaches none.
 *
 * A rung at or above `locality` is reached when it has any nodes.
 * A rung below `locality` is reached when its parent coverage is at least `floor`,
 * because locality nodes are the coverage denominator.
 */
export function bottomsOutAt(country: CountryGranularity, floor: number = DEFAULT_COVERAGE_FLOOR): ComponentTag | null {
	for (const rung of [...LADDER].toReversed()) {
		const measurement = country.rungs[rung]

		if (!measurement) continue

		const reached = SUB_LOCALITY_RUNGS.has(rung) ? measurement.parentCoverage >= floor : measurement.nodes > 0

		if (reached) return rung
	}

	return null
}
