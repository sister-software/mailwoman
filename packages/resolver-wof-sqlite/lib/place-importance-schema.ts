/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { referentialFromPopulation } from "@mailwoman/core/resolver"
import { allRows } from "@mailwoman/core/utils"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { Kysely } from "kysely"

/**
 * Describes one row of the `place_importance` table, keyed by WOF place id.
 */
export interface PlaceImportanceTable {
	id: number

	/**
	 * The population-anchored referential likelihood in [0, 1], from {@link referentialFromPopulation}.
	 *
	 * It is never NULL: a place without a population row scores 0, which means no
	 * population evidence and earns no boost rather than a penalty.
	 */
	referential: number

	/**
	 * The fan-out-guarded Wikipedia importance in [0, 1], or NULL when the place has no surviving concordance.
	 *
	 * NULL means absence, so consumers must not coalesce it to 0 or rank on it.
	 */
	encyclopedic: number | null

	/**
	 * Deprecated blend of the two scores, written by {@link blendImportance} for
	 * consumers that still need one scale.
	 *
	 * New code ranks on `referential` and displays `encyclopedic`.
	 */
	importance: number
}

/**
 * Types the `place_importance` table of a WOF admin database
 * for `new DatabaseClient<PlaceImportanceDatabase>(...)`.
 */
export interface PlaceImportanceDatabase {
	place_importance: PlaceImportanceTable
}

/**
 * Lists the `place_importance` columns in declaration order, each checked
 * against {@link PlaceImportanceTable}.
 */
export const PLACE_IMPORTANCE_COLUMNS = [
	"id",
	"referential",
	"encyclopedic",
	"importance",
] as const satisfies readonly (keyof PlaceImportanceTable)[]

/**
 * Drops and recreates the `place_importance` table with separate referential and encyclopedic columns.
 */
export async function createPlaceImportanceTable(db: Kysely<PlaceImportanceDatabase>): Promise<void> {
	await db.schema.dropTable("place_importance").ifExists().execute()

	await db.schema
		.createTable("place_importance")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("referential", "real", (c) => c.notNull())
		.addColumn("encyclopedic", "real")
		.addColumn("importance", "real", (c) => c.notNull())
		.execute()
}

/**
 * Caps how far the encyclopedic score may raise a place's blended importance above its referential score.
 *
 * Merely having an article scores about 0.25 to 0.35, above a mid-size town's referential score,
 * so without the cap a tiny village with an article outranks a large town without one.
 */
export const ENCYCLOPEDIC_BOOST_CAP = 0.25

/**
 * Blends the two channels into the legacy `importance` column: the referential score
 * when there is no article, the encyclopedic score alone when population is unknown
 * (`referential` 0), and otherwise the encyclopedic score clamped between the
 * referential score and {@link ENCYCLOPEDIC_BOOST_CAP} above it.
 */
export function blendImportance(referential: number, encyclopedic: number | null | undefined): number {
	if (encyclopedic === null || encyclopedic === undefined) return referential

	if (referential <= 0) return encyclopedic

	return Math.max(referential, Math.min(encyclopedic, referential + ENCYCLOPEDIC_BOOST_CAP))
}

/**
 * Names where {@link loadImportanceSplit} got its scores, which the FST stamp records as provenance.
 */
export const IMPORTANCE_SPLIT_SOURCES = {
	splitColumns: "split-columns",

	legacyReconstructed: "legacy-reconstructed",

	populationOnly: "population-only",

	none: "none",
} as const

/**
 * Identifies how an {@link ImportanceSplit} was obtained, as one of the
 * {@link IMPORTANCE_SPLIT_SOURCES} values.
 */
export type ImportanceSplitSource = (typeof IMPORTANCE_SPLIT_SOURCES)[keyof typeof IMPORTANCE_SPLIT_SOURCES]

/**
 * Returns the `select` term and `left join` that carry `encyclopedic` onto name-lookup
 * results for `schemaName`, degrading to `NULL` and no join when the column is absent.
 *
 * It probes for the column rather than the table, because a pre-split table's
 * `importance` mixes Wikipedia and population scores.
 * Cache the result per extract, since it runs a `PRAGMA` and lookups are per keystroke.
 */
export function encyclopedicClauses<DB>(db: DatabaseClient<DB>, schemaName: string): { select: string; join: string } {
	let present: boolean

	try {
		const rows = allRows<{ name: string }>(db.prepare(`PRAGMA ${schemaName}.table_info(place_importance)`))

		present = rows.some((r) => r.name === "encyclopedic")
	} catch {
		present = false
	}

	if (!present) return { select: "NULL AS encyclopedic", join: "" }

	return {
		select: "place_importance.encyclopedic AS encyclopedic",
		join: `LEFT JOIN ${schemaName}.place_importance ON place_importance.id = spr.id`,
	}
}

/**
 * Sets the relative tolerance within which {@link splitLegacyImportance} treats
 * a value as lying on the population curve.
 */
export const LEGACY_FALLBACK_EPSILON = 8 * Number.EPSILON

/**
 * Splits a legacy `place_importance` value into referential and encyclopedic scores,
 * treating it as a population fallback when it matches {@link referentialFromPopulation}
 * within {@link LEGACY_FALLBACK_EPSILON}.
 *
 * The match is tolerant because `log2` differs by an ULP across runtimes,
 * and bit equality would invent encyclopedic scores.
 */
export function splitLegacyImportance(
	legacy: number | undefined,
	population: number | null | undefined
): { referential: number; encyclopedic?: number } {
	const referential = referentialFromPopulation(population)

	if (legacy === undefined) return { referential }

	if (Math.abs(legacy - referential) <= LEGACY_FALLBACK_EPSILON * Math.max(referential, 1)) return { referential }

	return { referential, encyclopedic: legacy }
}

/**
 * The two score maps a builder needs, plus the provenance of how they were obtained.
 */
export interface ImportanceSplit {
	/**
	 * Referential likelihood by WOF ID, where a missing ID means 0 because only positive scores are stored.
	 */
	referential: Map<number, number>

	/**
	 * Encyclopedic importance by WOF ID, where a missing ID means no score and must not be filled with 0.
	 */
	encyclopedic: Map<number, number>
	source: ImportanceSplitSource

	/**
	 * The number of legacy rows attributed to the population fallback,
	 * nonzero only for the `legacy-reconstructed` source.
	 */
	legacyFallbackRows: number
}

function tableColumns<DB>(db: DatabaseClient<DB>, table: string): Set<string> {
	try {
		const rows = allRows<{ name: string }>(db.prepare(`PRAGMA table_info(${table})`))

		return new Set(rows.map((r) => r.name))
	} catch {
		return new Set()
	}
}

/**
 * Loads both importance scores from a WOF admin database, whichever schema generation it uses.
 */
export function loadImportanceSplit<DB>(db: DatabaseClient<DB>): ImportanceSplit {
	const referential = new Map<number, number>()
	const encyclopedic = new Map<number, number>()
	const population = new Map<number, number>()

	const populationColumns = tableColumns(db, "place_population")

	if (populationColumns.has("population")) {
		const rows = allRows<{
			id: number
			population: number
		}>(db.prepare("SELECT id, population FROM place_population"))

		for (const row of rows) {
			population.set(row.id, row.population)
			const score = referentialFromPopulation(row.population)

			if (score > 0) {
				referential.set(row.id, score)
			}
		}
	}

	const importanceColumns = tableColumns(db, "place_importance")

	if (importanceColumns.has("referential")) {
		const rows = allRows<{
			id: number
			referential: number
			encyclopedic: number | null
		}>(db.prepare("SELECT id, referential, encyclopedic FROM place_importance"))

		for (const row of rows) {
			if (row.referential > 0) {
				referential.set(row.id, row.referential)
			}

			if (row.encyclopedic !== null) {
				encyclopedic.set(row.id, row.encyclopedic)
			}
		}

		return { referential, encyclopedic, source: IMPORTANCE_SPLIT_SOURCES.splitColumns, legacyFallbackRows: 0 }
	}

	if (importanceColumns.has("importance")) {
		const rows = allRows<{
			id: number
			importance: number
		}>(db.prepare("SELECT id, importance FROM place_importance"))

		let legacyFallbackRows = 0

		for (const row of rows) {
			const split = splitLegacyImportance(row.importance, population.get(row.id))

			if (split.encyclopedic === undefined) {
				legacyFallbackRows++
			} else {
				encyclopedic.set(row.id, split.encyclopedic)
			}
		}

		return {
			referential,
			encyclopedic,
			source: IMPORTANCE_SPLIT_SOURCES.legacyReconstructed,
			legacyFallbackRows,
		}
	}

	return {
		referential,
		encyclopedic,
		source: referential.size ? IMPORTANCE_SPLIT_SOURCES.populationOnly : IMPORTANCE_SPLIT_SOURCES.none,
		legacyFallbackRows: 0,
	}
}
