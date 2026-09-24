/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measure the deepest available admin-gazetteer rung per country.
 *   Rung membership derives from `PLACETYPE_PROJECTION`; ordering is defined here.
 *   Upper rungs use node presence, while sub-locality rungs use parent coverage.
 *   Reads the admin database only.
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
 * Containment rungs from broadest to deepest; postcode is a separate channel.
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
 * Sub-locality rungs measured by parent coverage.
 */
export const SUB_LOCALITY_RUNGS: ReadonlySet<ComponentTag> = new Set<ComponentTag>([
	"dependent_locality",
	"venue",
	"unit",
])

/**
 * Locality-class parents used for coverage calculations.
 */
export const PARENT_PLACETYPES: readonly string[] = ["locality", "localadmin"]

/**
 * Return sorted WOF placetypes projecting onto a rung.
 */
export function placetypesForRung(rung: ComponentTag): string[] {
	return Object.entries(PLACETYPE_PROJECTION)
		.filter(([, tag]) => tag === rung)
		.map(([placetype]) => placetype)
		.toSorted()
}

/**
 * One country's measurement for a rung; measured empty rungs are zero-valued.
 */
export interface RungMeasurement {
	/**
	 * Current, non-deprecated nodes at this rung, both sources combined.
	 */
	nodes: number
	/**
	 * How many of {@link nodes} are Overture-backfilled
	 * (`OVERTURE_ID_BASE <= id < GEONAMES_ID_BASE`) rather than real WOF.
	 *
	 * For the Overture backfill set the locality rung and above are Overture,
	 * so a report that hid this would present self-comparison as corroboration.
	 */
	overtureBackfilled: number
	/**
	 * How many of {@link nodes} come from the GeoNames alias fold (`id >= GEONAMES_ID_BASE`).
	 *
	 * Split out from {@link overtureBackfilled} because a single `id >= OVERTURE_ID_BASE`
	 * test sweeps these in and mislabels every GeoNames-only country's rows as Overture.
	 */
	geonamesBackfilled: number
	/**
	 * Distinct locality-class parents carrying at least one child projecting onto this rung.
	 */
	parentsCovered: number
	/**
	 * {@link parentsCovered} over the country's locality-class node count.
	 * Zero when the country has no locality parents.
	 */
	parentCoverage: number
}

/**
 * One country's ladder.
 */
export interface CountryGranularity {
	country: string
	/**
	 * The parent-coverage denominator: current, non-deprecated `locality`/`localadmin` nodes.
	 */
	localityParents: number
	rungs: Partial<Record<ComponentTag, RungMeasurement>>
}

/**
 * Build a SQL `CASE` from the shared placetype projection.
 */
function rungCaseExpression(column: string): string {
	const whens = LADDER.flatMap((rung) =>
		placetypesForRung(rung).map((placetype) => `WHEN '${placetype}' THEN '${rung}'`)
	)

	return `CASE ${column} ${whens.join(" ")} END`
}

/**
 * Every placetype that lands on a ladder rung — the `IN` list bounding both queries.
 */
function ladderPlacetypes(): string[] {
	return LADDER.flatMap((rung) => placetypesForRung(rung))
}

/**
 * Measure the ladder with grouped, read-only queries.
 * Parent coverage counts each parent once per rung.
 */
export function buildGranularityLadder(adminDBPath: PathBuilderLike): CountryGranularity[] {
	using db = new DatabaseClient<WOFDatabase>(adminDBPath, { readOnly: true })

	const placetypeList = ladderPlacetypes()
		.map((placetype) => `'${placetype}'`)
		.join(", ")

	const parentList = PARENT_PLACETYPES.map((placetype) => `'${placetype}'`).join(", ")
	// Alias-qualified: the parent query joins `spr` to itself, so an unqualified `is_deprecated` is ambiguous.
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

		// Seed every rung at zero: the country was measured, so an empty rung is a present zero.
		// A rung with no measurable source at all is dropped by the caller rather than left implicit here.
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
 * The deepest rung a country actually reaches, or `null` when it has nothing live at any rung.
 *
 * Two presence rules, because parent-coverage is only meaningful below the locality backbone.
 * The backbone is its denominator.
 *
 * At or above `locality`, a rung counts as reached when it has any nodes.
 * Below it, when parent-coverage clears `floor`.
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
