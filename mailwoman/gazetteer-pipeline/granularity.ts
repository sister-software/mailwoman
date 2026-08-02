/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The gazetteer DEPTH LADDER — per-country measurement of where the admin gazetteer bottoms out,
 *   worldwide. Built 2026-08-02 after a probe found the shipped `admin-global-priority.db` stocks 9
 *   of WOF's 34 placetypes and carries a `dependent_locality` tier in 11 of 244 countries; the venue
 *   tier is empty. "Is WOF granular enough" had never been measured, and this module is the
 *   instrument.
 *
 *   Rung MEMBERSHIP derives from `PLACETYPE_PROJECTION` so the scorecard and the placetype census
 *   can never disagree about what projects where; rung ORDER is explicit here, because "bottoms out
 *   at" needs an ordering the projection map does not carry.
 *
 *   Two different presence rules, deliberately. Rungs at or above `locality` are measured by node
 *   PRESENCE — a country either has region rows or it does not. Rungs below it are measured by
 *   PARENT-COVERAGE SHARE: the fraction of the country's locality-class nodes carrying at least one
 *   child projecting onto that rung. That statistic is not invented here — the placetype-census
 *   probe measured GB's dependent-locality share at 33.2% of 16,987 locality-class surfaces and
 *   found it to be real conditional evidence, while WITHIN-node share carried none (WOF rarely
 *   parents a locality under a locality, so covered nodes read ~100% across the board).
 *
 *   Read-only against the admin DB: no network, no model, no writes.
 */

import { DatabaseSync } from "node:sqlite"

import type { ComponentTag } from "@mailwoman/core/types"

import { OVERTURE_ID_BASE } from "./admin/fold-overture.ts"
import { PLACETYPE_PROJECTION } from "./placetype-census.ts"

/**
 * The containment rungs, shallowest first. `postcode` is deliberately absent: it is an orthogonal channel (the
 * postcode-anchor path already ships, and `postalcode` has its own build), and folding it into a depth ladder would
 * make "bottoms out at" incoherent.
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
 * Rungs measured by parent-coverage share rather than node presence — everything BELOW the locality backbone, which is
 * the denominator those shares are taken against.
 */
export const SUB_LOCALITY_RUNGS: ReadonlySet<ComponentTag> = new Set<ComponentTag>([
	"dependent_locality",
	"venue",
	"unit",
])

/**
 * The locality-class placetypes that host address-bearing children — the parent set and the parent-coverage
 * denominator. Matches `PARENT_PLACETYPES` in `placetype-census.ts` by construction.
 */
export const PARENT_PLACETYPES: readonly string[] = ["locality", "localadmin"]

/**
 * WOF placetypes projecting onto a rung, sorted. Derived from {@link PLACETYPE_PROJECTION} rather than hand-listed, so
 * adding a placetype to the projection table automatically widens the rung it belongs to.
 */
export function placetypesForRung(rung: ComponentTag): string[] {
	return Object.entries(PLACETYPE_PROJECTION)
		.filter(([, tag]) => tag === rung)
		.map(([placetype]) => placetype)
		.toSorted()
}

/**
 * One rung's measurement for one country. A rung the builder LOOKED AT and found empty is a present row of zeroes; a
 * rung with no measurable source is absent from {@link CountryGranularity.rungs} entirely. Collapsing those two would
 * break the meaning-of-zero rule inside the artifact.
 */
export interface RungMeasurement {
	/**
	 * Current, non-deprecated nodes at this rung, both sources combined.
	 */
	nodes: number
	/**
	 * How many of {@link nodes} are Overture-backfilled (`id >= OVERTURE_ID_BASE`) rather than real WOF. For the
	 * 86-country backfill set the locality rung and above are partly Overture, so a report that hid this would present
	 * self-comparison as corroboration.
	 */
	overtureBackfilled: number
	/**
	 * Distinct locality-class parents carrying at least one child projecting onto this rung.
	 */
	parentsCovered: number
	/**
	 * {@link parentsCovered} over the country's locality-class node count. Zero when the country has no locality parents.
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
 * Build a `CASE` expression projecting a placetype column onto a rung name, generated from the projection table so it
 * cannot drift from it. Placetypes projecting onto nothing in {@link LADDER} fall through to NULL and are filtered by
 * the caller's `WHERE`.
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
 * Measure the depth ladder for every country in the admin DB.
 *
 * Read-only. Three grouped queries: node counts per (country, rung) with the source split, distinct covered parents per
 * (country, rung) through `ancestors`, and the locality-class denominator. The projection runs in SQL because a parent
 * with both a borough child and a neighbourhood child must count ONCE toward `dependent_locality` — counting distinct
 * parents per placetype and summing in JS would double it.
 */
export function buildGranularityLadder(adminDBPath: string): CountryGranularity[] {
	const db = new DatabaseSync(adminDBPath, { readOnly: true })

	try {
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
					SUM(CASE WHEN s.id >= ? THEN 1 ELSE 0 END) AS overtureBackfilled
				 FROM spr s
				 WHERE ${live("s")} AND s.country != '' AND s.placetype IN (${placetypeList})
				 GROUP BY s.country, rung`
			)
			.all(OVERTURE_ID_BASE) as Array<{
			country: string
			rung: ComponentTag
			nodes: number
			overtureBackfilled: number | null
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

			// Seed EVERY rung at zero: the country was measured, so an empty rung is a present zero. A rung with no
			// measurable source at all is dropped by the caller, not left implicit here.
			const rungs: Partial<Record<ComponentTag, RungMeasurement>> = {}

			for (const rung of LADDER) {
				rungs[rung] = { nodes: 0, overtureBackfilled: 0, parentsCovered: 0, parentCoverage: 0 }
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
	} finally {
		db.close()
	}
}

/**
 * Default parent-coverage floor for crediting a sub-locality rung.
 *
 * This is the weakest number in the design and is deliberately a parameter. GB — the one country with a validated
 * reading — sits around 33%, so 5% is far below the only calibration point we have; it is set low on purpose, to catch
 * thin-but-real tiers rather than to certify them. A second calibration point should harden it.
 */
export const DEFAULT_COVERAGE_FLOOR = 0.05

/**
 * The deepest rung a country actually reaches, or `null` when it has nothing live at any rung.
 *
 * Two presence rules, because parent-coverage is only meaningful BELOW the locality backbone — the backbone is its
 * denominator. At or above `locality`, a rung counts as reached when it has any nodes. Below it, when parent-coverage
 * clears `floor`.
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
