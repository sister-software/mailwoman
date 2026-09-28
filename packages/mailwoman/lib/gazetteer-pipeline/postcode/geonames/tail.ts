/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The GeoNames-postal tail database (`postalcode-geonames-tail-<date>.db`), postcode coverage for the
 *   countries without a WOF `whosonfirst-data-postalcode-<cc>` repo, reproducing the frozen artifact's
 *   ingest order so its ids stay comparable.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { md5File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { LayerTier } from "@mailwoman/core/layers"
import { repoRootPath } from "@mailwoman/core/paths"
import { isoDate } from "@mailwoman/core/utils"
import { EpistemicStatus } from "@mailwoman/evidence"
import type { GeonamesPostalIngestResult } from "@mailwoman/resolver-wof-sqlite/geonames"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { ExtractMetaTable, WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { UNDECLARED_INPUT_LICENSE } from "#gazetteer-pipeline/candidate-manifest"
import {
	applyStagingPragmas,
	buildDatabaseFTS,
	freezeStagingDatabase,
	removeStagingArtifacts,
	vacuumDatabaseInto,
} from "#gazetteer-pipeline/database-lifecycle"
import { DEFAULT_GEONAMES_TAIL_COUNTRIES } from "#gazetteer-pipeline/defaults"
import type { BuildFTSResult } from "#gazetteer-pipeline/fts"
import { buildSHA, foldLayerManifest, stampLayerManifest } from "#gazetteer-pipeline/stamp-manifest"

export { DEFAULT_GEONAMES_TAIL_COUNTRIES } from "#gazetteer-pipeline/defaults"

/**
 * The terms the artifact's `layer_manifest` records for a given country list, carrying
 * `LicenseRef-Undeclared-Input` at `build-local` because GB's Northern Ireland rows have no documented
 * provenance.
 */
export function geonamesTailTerms(countries: readonly string[]): { tier: LayerTier; license: string } {
	if (countries.includes("GB")) {
		return {
			tier: LayerTier.BuildLocal,
			license: `CC-BY-4.0 AND OGL-UK-3.0 AND ${UNDECLARED_INPUT_LICENSE}`,
		}
	}

	return { tier: LayerTier.Shipped, license: "CC-BY-4.0" }
}

/**
 * Kysely read/write interface for the database's provenance table, read at open so the licence obligation
 * and source fingerprints travel with the database.
 */
export interface DatabaseMetaDatabase {
	meta: ExtractMetaTable
}

/**
 * Create the provenance `meta` table, co-located with {@link DatabaseMetaDatabase} so a column added to one
 * is a compile error against the other.
 */
export async function createDatabaseMetaTable<DB extends DatabaseMetaDatabase>(db: DatabaseClient<DB>): Promise<void> {
	const kdb = db

	await kdb.schema
		.createTable("meta")
		.ifNotExists()
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text")
		.execute()
}

/**
 * Upsert provenance rows into a `meta` table the caller has already created, one implementation for every
 * database and postcode-locality builder.
 */
export function writeMetaRows<DB>(db: DatabaseClient<DB>, rows: ReadonlyArray<readonly [string, string]>): void {
	const insert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")

	for (const [key, value] of rows) {
		insert.run(key, value)
	}
}

/**
 * What a source dump contributed, fingerprinted, where `rows` is the distinct normalized-postcode count
 * well below the dump's line count wherever GeoNames carries one row per (postcode, settlement).
 */
export interface GeonamesPostalSourceFact {
	country: string
	file: string
	bytes: number
	md5: string
	rows: number
	/**
	 * How many of those codes the dump carried on several rows that all named one coordinate, which GeoNames
	 * averages from neighbouring codes where a name match fails, so the count tells a consumer how much of a
	 * country's coverage is inherited rather than agreed.
	 */
	singlePointRows: number
}

export interface BuildPostcodeGeonamesTailOptions {
	/**
	 * ISO-2 countries to fold, in ingest order, defaulting to {@link DEFAULT_GEONAMES_TAIL_COUNTRIES}.
	 */
	countries?: readonly string[]
	/**
	 * GeoNames postal dump dir holding `<CC>.txt` (download.geonames.org/export/zip), defaulting to
	 * `<data-root>/geonames-postal`.
	 */
	postalDir?: PathBuilderLike
	/**
	 * Output artifact, defaulting to `<data-root>/db/wof/postalcode-geonames-tail-<yyyy-MM-DD>.db`;
	 * promoting it over the shipped `postalcode-geonames-tail.db` is a deliberate, separate swap.
	 */
	out?: PathBuilderLike
	/**
	 * Build clock, stamped into `meta.built_at` and the default output name, passed in so the module never
	 * reads the clock implicitly (the `defaultGazetteerVersion` convention).
	 */
	now?: Date
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildPostcodeGeonamesTailResult {
	out: string
	countries: string[]
	/**
	 * Distinct postcodes inserted across all countries.
	 */
	inserted: number
	byCountry: Record<string, number>
	/**
	 * Countries whose `<CC>.txt` was absent, reported rather than fatal because the parity check decides
	 * whether the partial database may be promoted.
	 */
	missing: string[]
	sources: GeonamesPostalSourceFact[]
	ancestorRows: number
	ftsRows: number
	bboxRows: number
	sealed: boolean
}

/**
 * Build the sealed GeoNames-postal tail database.
 */
export async function buildPostcodeGeonamesTail(
	opts: BuildPostcodeGeonamesTailOptions = {}
): Promise<BuildPostcodeGeonamesTailResult> {
	const phase = opts.onPhase ?? (() => {})
	const now = opts.now ?? new Date()
	const countries = [...(opts.countries ?? DEFAULT_GEONAMES_TAIL_COUNTRIES)].map((c) => c.toUpperCase())
	const postalDir = PathBuilder.from(opts.postalDir ?? dataRootPath("geonames-postal"))
	const out = (opts.out ?? wofDatabasePath(`postalcode-geonames-tail-${isoDate(now)}.db`)).toString()

	if (!(await pathExists(postalDir))) {
		throw new Error(
			`buildPostcodeGeonamesTail: no GeoNames postal dir at ${postalDir} — fetch download.geonames.org/export/zip/<CC>.zip`
		)
	}

	// Imported here so loading this module does not evaluate resolver-wof-sqlite (the gazetteer-pipeline convention).
	const { createUnifiedSchema, createUnifiedIndexes, populateAncestors } =
		await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const { ingestGeonamesPostal } = await import("@mailwoman/resolver-wof-sqlite/geonames")

	const ingestPath = out + ".ingest"
	await removeStagingArtifacts(ingestPath)

	phase("staging", ingestPath)

	let ingest: GeonamesPostalIngestResult

	let sources: GeonamesPostalSourceFact[]

	let ancestorRows: number

	{
		using db = new DatabaseClient<WOFDatabase>(ingestPath)

		applyStagingPragmas(db)

		await createUnifiedSchema(db)

		phase("ingest", `${countries.join(",")} ← ${postalDir}`)
		ingest = await ingestGeonamesPostal(db, countries, postalDir)
		phase("ingest", `${ingest.inserted.toLocaleString()} distinct postcodes`)

		// Every row's parent_id is -1, so this writes the self row per place; the resolver's
		// parent-constraint reads `ancestors`, and a place absent from it can never satisfy it.
		phase("ancestors")
		ancestorRows = populateAncestors(db)
		phase("ancestors", `${ancestorRows.toLocaleString()} rows`)

		phase("indexes")
		await createUnifiedIndexes(db)

		phase("meta")
		sources = await collectSourceFacts(countries, postalDir, ingest.byCountry, ingest.singlePointByCountry)
		await writeDatabaseMeta(db, { now, countries, sources, inserted: ingest.inserted })

		phase("freeze")
		freezeStagingDatabase(db)

		phase("vacuum", out)
		await vacuumDatabaseInto(db, out)
	}

	await removeStagingArtifacts(ingestPath)

	phase("fts")

	const fts: BuildFTSResult = await buildDatabaseFTS(
		out,
		(path) => new DatabaseClient<DatabaseMetaDatabase>(path),
		phase
	)

	// The layer interface's manifest beside the `meta` record; the candidate build reads its tier before
	// folding the database.
	phase("layer-manifest")

	await stampLayerManifest(
		out,
		foldLayerManifest({
			name: "postalcode-geonames-tail",
			version: isoDate(now),
			...geonamesTailTerms(countries),
			attribution: GEONAMES_ATTRIBUTION,
			source: "GeoNames postal-code dumps",
			sourceVintage: `${countries.join(",")} (${sources.length} of ${countries.length} dumps present)`,
			buildCmd: `mailwoman gazetteer build postcode-geonames --countries ${countries.join(",")}`,
			buildSHA: buildSHA(repoRootPath()),
			createdAt: now.toISOString(),
			spineKeys: { wofID: "id" },
		})
	)

	phase("seal")
	await sealDatabase(out)

	return {
		out,
		countries,
		inserted: ingest.inserted,
		byCountry: ingest.byCountry,
		missing: ingest.missing,
		sources,
		ancestorRows,
		ftsRows: fts.ftsRows,
		bboxRows: fts.bboxRows,
		sealed: true,
	}
}

/**
 * Fingerprint each present source dump, giving a missing country no fact row rather than a zeroed one
 * because `rows: 0` would read as measured-empty rather than never present.
 */
async function collectSourceFacts(
	countries: readonly string[],
	postalDir: PathBuilder,
	byCountry: Record<string, number>,
	singlePointByCountry: Record<string, number>
): Promise<GeonamesPostalSourceFact[]> {
	const facts: GeonamesPostalSourceFact[] = []

	for (const country of countries) {
		const file = postalDir(`${country}.txt`)

		if (!(await pathExists(file))) continue

		facts.push({
			country,
			file: `${country}.txt`,
			bytes: (await statPath(file)).size,
			md5: await md5File(file),
			rows: byCountry[country] ?? 0,
			singlePointRows: singlePointByCountry[country] ?? 0,
		})
	}

	return facts
}

/**
 * The attribution GeoNames' CC-BY 4.0 requires of a redistributor.
 */
const GEONAMES_ATTRIBUTION = "Contains data from GeoNames (geonames.org), © GeoNames contributors, CC-BY 4.0"

/**
 * GB is not plain GeoNames provenance: the GB rows derive from Ordnance Survey Code-Point Open under OGL
 * v3, whose OS attribution block a redistributor must carry, while the ~48,990 `BT` rows plus IM/GY/JE have
 * no documented provenance.
 */
const GB_LICENSE_NOTE =
	"GB rows come from the GeoNames GB_full dump, whose GB (England/Scotland/Wales) portion derives from Ordnance " +
	"Survey Code-Point Open under Open Government Licence v3 — NOT CC-BY alone, which GeoNames' readme claims. " +
	"Redistributing the GB rows requires the OS block, with the year of YOUR publication: " +
	'"Contains OS data © Crown copyright and database right <year>. ' +
	"Contains Royal Mail data © Royal Mail copyright and database right <year>. " +
	"Contains National Statistics data © Crown copyright and database right <year>. " +
	'Licensed under the Open Government Licence v3.0 (nationalarchives.gov.uk/doc/open-government-licence/version/3/)." ' +
	"UNRESOLVED: ~48,990 BT (Northern Ireland) rows plus IM/GY/JE lie outside Code-Point Open coverage with no " +
	"documented provenance; ONS's OGL grant for postcode products excludes Northern Ireland data and commercial NI " +
	"use requires a separate Land & Property Services licence. Counsel sign-off pending, as with @mailwoman/osm."

interface DatabaseMetaInput {
	now: Date
	countries: readonly string[]
	sources: readonly GeonamesPostalSourceFact[]
	inserted: number
}

/**
 * Bake the provenance record into the staging DB before vacuum and seal, since a shipped DB is never
 * patched, with `sources` stored as JSON so the per-file md5s stay machine-readable.
 */
async function writeDatabaseMeta<DB extends DatabaseMetaDatabase>(
	db: DatabaseClient<DB>,
	input: DatabaseMetaInput
): Promise<void> {
	await createDatabaseMetaTable(db)

	const rows: Array<[string, string]> = [
		["name", "mailwoman-postalcode-geonames-tail"],
		[
			"description",
			"GeoNames postcodes as first-class WOF `postalcode` places for the countries without a whosonfirst-data-postalcode repo (#920)",
		],
		["schema_version", "1"],
		["built_at", input.now.toISOString()],
		["countries", input.countries.join(",")],
		["postcode_rows", String(input.inserted)],
		["source", "GeoNames postal-code dumps — download.geonames.org/export/zip/<CC>.zip (GB: GB_full)"],
		["license", "CC-BY 4.0 (GeoNames) — attribution required on redistribution"],
		["attribution", GEONAMES_ATTRIBUTION],
		["license_gb", GB_LICENSE_NOTE],
		[
			"method",
			"#920 laws: `name` stored in the sanitized-query token shape (every non-letter/number stripped) with the display form as an alt `names` row; centroid is the MEDOID member point (never the mean) of the DISTINCT (postcode, settlement) coordinates — rows sharing a coordinate collapse to one observation before the medoid reads them",
		],
		[
			"coordinate_epistemic_status",
			`${EpistemicStatus.Derived} — GeoNames computes a postal coordinate by matching the code against place names and admin divisions, and averages neighbouring codes where the match fails. These points are an estimate of the code's neighbourhood under a stated rule, not a postal authority's centroid; \`source_files[].singlePointRows\` counts the codes whose several rows all named ONE such point`,
		],
		["builder", "mailwoman gazetteer build postcode-geonames --countries " + input.countries.join(",")],
		["source_files", stringifyJSON(input.sources)],
	]

	writeMetaRows(db, rows)
}
