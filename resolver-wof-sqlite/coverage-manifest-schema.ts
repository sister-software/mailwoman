/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema + read/write helpers for the candidate gazetteer's COVERAGE MANIFEST — the two
 *   country-keyed tables through which the artifact declares facts about ITSELF, so those facts are
 *   updated at gazetteer REBUILD, not by a hand-edited code PR after someone remembers:
 *
 *   - `country_coverage`: the hard-country-filter coverage record (#743/#194) — per-country
 *     promote-gate verdicts + the measured hard-resolve rates that used to live in a code comment on
 *     `HARD_PLACE_COUNTRY_SAFELIST`. Presence = measured; `hard_filter_safe = 0` = measured and
 *     FAILED the gate (FI 69.5%, PL 77.8%) — distinguishable from a country never measured at all
 *     (the meaning-of-zero rule, `docs/articles/plan/reference/layer-contract.mdx`).
 *   - `country_bbox`: the coarse guard-B plausibility boxes that used to live in
 *     `resolver/plausibility.ts`'s `COUNTRY_BBOX`. An absent row fails open (never trips the guard),
 *     exactly like an absent key in the constant.
 *
 *   Emission happens at build time (`mailwoman/gazetteer-pipeline/coverage-manifest.ts` owns the
 *   measured record and calls {@link writeGazetteerCoverageManifest} before the DB is sealed — never
 *   patch a shipped DB, rebuild). The read happens at open time ({@link WOFCandidateTableLookup}
 *   calls {@link readGazetteerCoverageManifest} in its constructor); an artifact that predates the
 *   manifest returns `undefined` and every consumer falls back to the code constants byte-identically.
 */

import type { DatabaseSync } from "node:sqlite"

import {
	hardCountrySafelistFromCoverage,
	type CountryBBoxFact,
	type CountryCoverageFact,
	type GazetteerArtifactCoverage,
} from "@mailwoman/core/resolver"
import { sql, type Kysely } from "kysely"

import { hasTable } from "./sqlite-utils.ts"

/**
 * One country's hard-filter coverage measurement — the storage form of {@link CountryCoverageFact}.
 */
export interface CountryCoverageTable {
	/**
	 * ISO 3166-1 alpha-2, uppercase (PK).
	 */
	country: string
	/**
	 * 0/1 — the promote-gate verdict (a verdict column, NOT re-derived from the rate; see the fact type's docstring).
	 */
	hard_filter_safe: number
	/**
	 * Measured hard-resolve rate 0..1 on the panel named in `source`; NULL when the receipt recorded none.
	 */
	hard_resolve_rate: number | null
	/**
	 * Panel size behind `hard_resolve_rate`; NULL when unrecorded.
	 */
	sample_size: number | null
	/**
	 * ISO-8601 date of the measurement / promote gate.
	 */
	measured_at: string
	/**
	 * The receipt: which panel/gate produced this row.
	 */
	source: string
}

/**
 * One country's coarse guard-B bounding box — the storage form of {@link CountryBBoxFact}.
 */
export interface CountryBBoxTable {
	/**
	 * ISO 3166-1 alpha-2, uppercase (PK).
	 */
	country: string
	lat_min: number
	lat_max: number
	lon_min: number
	lon_max: number
	/**
	 * Provenance of the box (harness + date).
	 */
	source: string
}

/**
 * The coverage-manifest schema for `new DatabaseClient<GazetteerCoverageDatabase>(...)`.
 */
export interface GazetteerCoverageDatabase {
	country_coverage: CountryCoverageTable
	country_bbox: CountryBBoxTable
}

/**
 * Table names the lookup probes (existence-gated, so a candidate.db built before the manifest is byte-stable).
 */
export const COUNTRY_COVERAGE_TABLE = "country_coverage"
/**
 * Table of per-country bounding boxes, used to reject a placement that fell outside its own country.
 */
export const COUNTRY_BBOX_TABLE = "country_bbox"

/**
 * Create `country_coverage` — a handful of small PK-probed rows, the WITHOUT ROWID sweet spot.
 */
export async function createCountryCoverageTable(db: Kysely<GazetteerCoverageDatabase>): Promise<void> {
	await db.schema
		.createTable(COUNTRY_COVERAGE_TABLE)
		.ifNotExists()
		.addColumn("country", "text", (c) => c.primaryKey())
		.addColumn("hard_filter_safe", "integer", (c) => c.notNull())
		.addColumn("hard_resolve_rate", "real")
		.addColumn("sample_size", "integer")
		.addColumn("measured_at", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create `country_bbox` — same shape discipline as {@link createCountryCoverageTable}.
 */
export async function createCountryBBoxTable(db: Kysely<GazetteerCoverageDatabase>): Promise<void> {
	await db.schema
		.createTable(COUNTRY_BBOX_TABLE)
		.ifNotExists()
		.addColumn("country", "text", (c) => c.primaryKey())
		.addColumn("lat_min", "real", (c) => c.notNull())
		.addColumn("lat_max", "real", (c) => c.notNull())
		.addColumn("lon_min", "real", (c) => c.notNull())
		.addColumn("lon_max", "real", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Write the coverage manifest into a candidate DB UNDER CONSTRUCTION (pre-seal — a shipped DB is never patched, rebuild
 * instead). Creates both tables and inserts the facts; call exactly once, from the gazetteer build.
 */
export async function writeGazetteerCoverageManifest(
	db: Kysely<GazetteerCoverageDatabase>,
	facts: { coverage: readonly CountryCoverageFact[]; bboxes: readonly CountryBBoxFact[] }
): Promise<void> {
	await createCountryCoverageTable(db)
	await createCountryBBoxTable(db)

	if (facts.coverage.length) {
		await db
			.insertInto(COUNTRY_COVERAGE_TABLE)
			.values(
				facts.coverage.map((f) => ({
					country: f.country.toUpperCase(),
					hard_filter_safe: f.hardFilterSafe ? 1 : 0,
					hard_resolve_rate: f.hardResolveRate ?? null,
					sample_size: f.sampleSize ?? null,
					measured_at: f.measuredAt,
					source: f.source,
				}))
			)
			.execute()
	}

	if (facts.bboxes.length) {
		await db
			.insertInto(COUNTRY_BBOX_TABLE)
			.values(
				facts.bboxes.map((f) => ({
					country: f.country.toUpperCase(),
					lat_min: f.latMin,
					lat_max: f.latMax,
					lon_min: f.lonMin,
					lon_max: f.lonMax,
					source: f.source,
				}))
			)
			.execute()
	}
}

/**
 * Read the coverage manifest from an OPEN candidate DB, or `undefined` when the artifact predates it (neither table
 * present) — the signal for consumers to fall back to the code constants byte-identically. Synchronous raw reads on
 * purpose: this runs inside {@link WOFCandidateTableLookup}'s synchronous constructor (the sync-reader carve-out in
 * `AGENTS.md`), and the tables are a few dozen rows read once per open.
 */
export function readGazetteerCoverageManifest(db: DatabaseSync): GazetteerArtifactCoverage | undefined {
	const hasCoverage = hasTable(db, COUNTRY_COVERAGE_TABLE)
	const hasBBox = hasTable(db, COUNTRY_BBOX_TABLE)

	if (!hasCoverage && !hasBBox) return undefined

	const countryCoverage = new Map<string, CountryCoverageFact>()

	if (hasCoverage) {
		const rows = db
			.prepare(
				`SELECT country, hard_filter_safe, hard_resolve_rate, sample_size, measured_at, source FROM ${COUNTRY_COVERAGE_TABLE}`
			)
			.all() as unknown as CountryCoverageTable[]

		for (const row of rows) {
			const country = String(row.country).toUpperCase()
			countryCoverage.set(country, {
				country,
				hardFilterSafe: Number(row.hard_filter_safe) !== 0,
				...(row.hard_resolve_rate === null ? {} : { hardResolveRate: Number(row.hard_resolve_rate) }),
				...(row.sample_size === null ? {} : { sampleSize: Number(row.sample_size) }),
				measuredAt: String(row.measured_at),
				source: String(row.source),
			})
		}
	}

	const countryBBoxes = new Map<string, CountryBBoxFact>()

	if (hasBBox) {
		const rows = db
			.prepare(`SELECT country, lat_min, lat_max, lon_min, lon_max, source FROM ${COUNTRY_BBOX_TABLE}`)
			.all() as unknown as CountryBBoxTable[]

		for (const row of rows) {
			const country = String(row.country).toUpperCase()
			countryBBoxes.set(country, {
				country,
				latMin: Number(row.lat_min),
				latMax: Number(row.lat_max),
				lonMin: Number(row.lon_min),
				lonMax: Number(row.lon_max),
				source: String(row.source),
			})
		}
	}

	return {
		countryCoverage,
		countryBBoxes,
		hardCountrySafelist: hardCountrySafelistFromCoverage(countryCoverage.values()),
	}
}
