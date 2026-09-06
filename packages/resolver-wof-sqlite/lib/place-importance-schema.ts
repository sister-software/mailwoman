/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The TWO-SCORE SPLIT (ROAD_TO_V9 §2 R1) — typed schema, table builder, and the two derivations, in
 *   one module so the read contract and the DDL cannot drift.
 *
 *   THE POLICY THIS ENCODES, ratified 2026-08-06: **the importance of a knowledge-base article is not
 *   the probability that this is the place the user means.** The geocoder ranks by REFERENTIAL
 *   likelihood; encyclopedic importance is carried as data and is never the ranking key. So the one
 *   `place_importance.importance` column — which was a Wikipedia score where the concordance join
 *   landed and a population-derived pseudo-score everywhere else — becomes two named columns that can
 *   never be confused for one another:
 *
 *   - {@link PlaceImportanceTable.referential} — population-anchored, ALWAYS derivable, the ranking
 *     backbone. {@link referentialFromPopulation} is the normalization the FST builder's population
 *     fallback has always used; naming it here is the whole change.
 *   - {@link PlaceImportanceTable.encyclopedic} — the fan-out-guarded Wikipedia join
 *     (`importance-fanout.ts`, #1497). NULLABLE, and null means ABSENT, never "an importance of
 *     zero": ~1.5 M of the 1.54 M rows in the 2026-08-05 build have no Wikipedia article at all, and
 *     a consumer that reads a 0 there would be reading a fact nobody recorded.
 *
 *   WHY SAINT-DENIS IS THE TEST. The Seine-Saint-Denis suburb (pop 96,128) carries encyclopedic
 *   0.1173; the Aude hamlet (pop 418) carries 0.5683 — the encyclopedic signal ranks the hamlet 4.8x
 *   ABOVE the place every user means. Referentially the suburb wins by 230x on population. One score
 *   cannot serve both readers, which is why there are two.
 *
 *   THE LEGACY COLUMN STAYS, AND IS DERIVED. `importance` is written by {@link blendImportance} — the
 *   bounded blend the bare-toponym fame consumer (#28) ranks on. It is the CONFLATION, and nothing new
 *   should read it; new code reads the split columns.
 */

import { referentialFromPopulation } from "@mailwoman/core/resolver"
import { allRows } from "@mailwoman/core/utils"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { Kysely } from "kysely"

//#region Schema

/**
 * One row of `place_importance`. Keyed by WOF place id.
 */
export interface PlaceImportanceTable {
	id: number
	/**
	 * Population-anchored referential likelihood in [0, 1] — see {@link referentialFromPopulation}. NOT NULL because it is
	 * always derivable: a place with no population row scores 0, which here genuinely means "no population evidence", the
	 * same state the ranking has always treated as "no boost, never a penalty".
	 */
	referential: number
	/**
	 * Fan-out-guarded Wikipedia importance in [0, 1], or NULL when this place has no surviving concordance. NULL is
	 * ABSENCE — never coalesce it to 0 in a consumer, and never rank on it at all.
	 */
	encyclopedic: number | null
	/**
	 * DEPRECATED — the pre-split conflation, written by {@link blendImportance} so the bare-toponym fame consumer (#28)
	 * keeps one cross-bearer scale. New code reads {@link PlaceImportanceTable.referential} (to rank) or
	 * {@link PlaceImportanceTable.encyclopedic} (to display).
	 */
	importance: number
}

/**
 * The `place_importance` slice of a WOF admin database, for `new DatabaseClient<PlaceImportanceDatabase>(...)`.
 */
export interface PlaceImportanceDatabase {
	place_importance: PlaceImportanceTable
}

/**
 * The columns in declaration order. The builder's INSERT derives its column list from this, so a field added to
 * {@link PlaceImportanceTable} without a matching DDL column is a compile error at the insert site.
 */
export const PLACE_IMPORTANCE_COLUMNS = [
	"id",
	"referential",
	"encyclopedic",
	"importance",
] as const satisfies readonly (keyof PlaceImportanceTable)[]

/**
 * Create `place_importance` at the split schema. Drops any existing table first — this is a rebuild-in-place step of
 * `mailwoman gazetteer importance`, never a migration.
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

//#endregion

//#region The referential derivation

/**
 * Re-exported from `@mailwoman/core/resolver`, which is where the derivation lives so that `@mailwoman/resolver`
 * (backend-agnostic — it cannot import this package) reads the same number. Re-exported HERE so the schema module stays
 * the one-stop read for the table: the column and the function that fills it are one hop apart.
 */

//#endregion

//#region The legacy blend

/**
 * The most the encyclopedic channel may raise a place's blended importance above its population-anchored referential
 * score.
 *
 * In referential units 0.25 is 3.5 population doublings (the referential curve divides log2 by 14), so an article can
 * promote a place as if it were up to ~11x its recorded population — never more. The bound exists because the two
 * channels' scales CROSS at the article floor: merely having a Wikipedia article scores ~0.25–0.35, which exceeds the
 * referential score of a mid-size town, so an unbounded blend ranks a 136-person village with an article above a
 * 16,026-person town without one.
 *
 * The value is bracketed by two decided contests, measured on the 2026-08-24 staging build:
 *
 * - `> 0.2282`, or bare `Whitby` stops answering Whitby GB (pop 13,130, referential 0.2729, encyclopedic 0.5496) over
 *   Whitby CA (pop 128,377, referential 0.5011) — the #28 design case the fame prior exists to serve.
 * - `< 0.2790`, or bare `Tó`/`To` answers Tó PT (pop 136, referential 0.0131, encyclopedic 0.3375) over Tô BF (pop
 *   16,026, no article) — the `bf-gloss-to-*` board pair.
 *
 * 0.25 sits mid-interval with ~0.02 margin to each bound.
 */
export const ENCYCLOPEDIC_BOOST_CAP = 0.25

/**
 * The legacy `importance` blend — one cross-bearer fame scale for the #28 consumer, derived from the two split
 * channels:
 *
 * - No article → the referential score.
 * - No population evidence (`referential` 0) → the encyclopedic score stands alone: there is nothing to bound the
 *   article's claim against, and a constant cap would demote every famous place WOF records no population for
 *   (meaning-of-zero: referential 0 is "unmeasured", not "tiny").
 * - Both present → the encyclopedic value clamped to at most {@link ENCYCLOPEDIC_BOOST_CAP} above the referential score,
 *   and never below it. The floor half repairs the downward inversion (the Seine-Saint-Denis suburb's weak article
 *   scored 0.1173 and REPLACED its referential 0.4716 under the old `COALESCE`, so a 418-person Aude hamlet outranked
 *   it 4.8x); the cap half repairs the upward one (`Tó`, above).
 *
 * Scale of the clamp on the 2026-08-24 staging build: of 628,202 article-bearing rows, 209,738 sit above the cap and
 * 13,888 sit below their referential floor; the 305,168 article-without-population rows pass through unchanged.
 */
export function blendImportance(referential: number, encyclopedic: number | null | undefined): number {
	if (encyclopedic === null || encyclopedic === undefined) return referential

	if (referential <= 0) return encyclopedic

	return Math.max(referential, Math.min(encyclopedic, referential + ENCYCLOPEDIC_BOOST_CAP))
}

//#endregion

//#region Reading a database that may or may not carry the split

/**
 * Where a reader's two scores came from. Recorded into the FST stamp so an artifact says, in its own provenance,
 * whether its encyclopedic channel is real, reconstructed, or absent.
 */
export const IMPORTANCE_SPLIT_SOURCES = {
	/**
	 * `place_importance` carries `referential` + `encyclopedic` — the post-split build.
	 */
	splitColumns: "split-columns",
	/**
	 * `place_importance` carries only the conflated `importance`; the split was RECONSTRUCTED against `place_population`
	 * (see {@link splitLegacyImportance}).
	 */
	legacyReconstructed: "legacy-reconstructed",
	/**
	 * No `place_importance` at all — referential from `place_population`, encyclopedic absent for every place.
	 */
	populationOnly: "population-only",
	/**
	 * Neither table. Every score is 0, and 0 here means the database carries no salience evidence whatsoever.
	 */
	none: "none",
} as const

export type ImportanceSplitSource = (typeof IMPORTANCE_SPLIT_SOURCES)[keyof typeof IMPORTANCE_SPLIT_SOURCES]

/**
 * The `SELECT` term and `LEFT JOIN` a name lookup needs in order to CARRY `encyclopedic` onto its results, probed
 * against `schemaName`'s `place_importance`.
 *
 * THE PROBE IS A COLUMN, NOT A TABLE, and that is the whole reason this lives here rather than beside a caller's other
 * table probes. The pre-split table exists and holds a single conflated `importance` column whose value is a Wikipedia
 * score on some rows and a population proxy on others, with nothing in the row to say which — reading that as
 * encyclopedic would surface the exact confusion ROAD_TO_V9 §2 exists to end.
 *
 * There is deliberately no ORDER BY counterpart, and there should never be one: §2's policy is that this score is
 * carried and never ranked on. Without the column the select degrades to a literal `NULL` and the join is the empty
 * string, so a pre-split extract's query plan is byte-identical to what it was before the split. No shipped gazetteer
 * carries the column yet, so today that degraded form is the only one anything builds.
 *
 * Call it ONCE per extract and cache the result — it runs a `PRAGMA`, and the callers are per-keystroke hot.
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
 * The tolerance {@link splitLegacyImportance} treats as "this value reproduces the population curve". Eight ULP —
 * comfortably wider than the one-ULP `log2` spread measured between CPython and V8 (see that function's docstring), and
 * ~1e-15 absolute against scores Nominatim publishes to four decimals.
 */
export const LEGACY_FALLBACK_EPSILON = 8 * Number.EPSILON

/**
 * Split one row of a LEGACY (pre-split) `place_importance` table back into its two components.
 *
 * WHY THIS IS RECOVERABLE AT ALL. The legacy builder ran in two passes: Wikipedia scores first, then `INSERT OR IGNORE`
 * of `min(1, log2(1+pop/1000)/14)` for every place with a population that Wikipedia had missed. So a legacy value is a
 * fallback row IFF it reproduces {@link referentialFromPopulation} of that place's population — the two passes wrote
 * different arithmetic, and a score from Nominatim's four-decimal TSV landing on the log2 curve is a measure-zero
 * event.
 *
 * THE COMPARISON IS ULP-TOLERANT, AND THAT IS NOT DEFENSIVE PADDING. The first version compared for exact bit equality,
 * which is correct — in the runtime that wrote the values. Cross-checking the same rule in CPython returned 166,638
 * encyclopedic rows against Node's 133,096: `math.log2` and V8's `Math.log2` disagree by one ULP on 33,542 of the 1.5 M
 * inputs (worked example: wof 85803233, population 21,299 — stored 0.31992193633838988953, CPython
 * 0.31992193633838994504, delta 5.55e-17). Bit equality would therefore INVENT 33,542 encyclopedic scores for anyone
 * who ported this rule to another runtime, and invented data is the failure mode this whole module exists to end. The
 * tolerance is a few ULP of the score's own magnitude; a genuine Wikipedia value that close to the population curve is
 * not distinguishable from it by any consequence.
 *
 * MEASURED, not reasoned (2026-08-06, `wof/fst-staging-2026-08-05/admin-global-priority-importance.db`): 1,543,753 rows
 * split **1,410,657 fallback / 133,096 encyclopedic**, and the arithmetic closes on itself — 1,410,657 + 108,861
 * (encyclopedic rows that ALSO have a population) = 1,519,518, which is exactly the count of `place_population` rows
 * with `population > 0`, i.e. every row the fallback pass could have written. The remaining 24,235 encyclopedic rows
 * have no population row at all. Under the exact-equality rule, Node found ZERO mismatches within one ULP, so the
 * tolerance changes no classification on this database — it only makes the answer runtime-independent.
 *
 * Referential is NOT read out of the legacy column under any branch — it is always re-derived from population, because
 * a legacy Wikipedia row overwrote whatever population would have said.
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
	 * WOF id → referential likelihood. Sparse: absent means 0 (no population evidence).
	 */
	referential: Map<number, number>
	/**
	 * WOF id → encyclopedic importance. Sparse, and ABSENCE IS ABSENCE — never fill a 0 in.
	 */
	encyclopedic: Map<number, number>
	source: ImportanceSplitSource
	/**
	 * Rows the legacy reconstruction attributed to the population fallback (only meaningful under
	 * {@link IMPORTANCE_SPLIT_SOURCES.legacyReconstructed}).
	 */
	legacyFallbackRows: number
}

/**
 * Does `table` exist in `db`, and if so which of `columns` does it have?
 */
function tableColumns<DB>(db: DatabaseClient<DB>, table: string): Set<string> {
	try {
		const rows = allRows<{ name: string }>(db.prepare(`PRAGMA table_info(${table})`))

		return new Set(rows.map((r) => r.name))
	} catch {
		return new Set()
	}
}

/**
 * Load both scores from a WOF admin database, whatever schema generation it is at.
 *
 * Handles all four states in {@link IMPORTANCE_SPLIT_SOURCES} so callers never branch on schema themselves — the FST
 * builder in particular must read the shipped population-only databases, the read-only 2026-08-05 staging database
 * (legacy conflated column), and post-split builds with one code path.
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
		// Post-split build: the columns ARE the contract. Referential is read verbatim rather than
		// re-derived, so a build that scored referential differently stays visible instead of being
		// silently overwritten by this reader's own formula.
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

//#endregion
