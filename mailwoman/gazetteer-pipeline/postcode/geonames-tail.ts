/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The GeoNames-postal tail shard (`postalcode-geonames-tail-<date>.db`) — postcode coverage for the
 *   countries whose WOF `whosonfirst-data-postalcode-<cc>` repos don't exist (#920: FI/CZ/SK/SI/DK/
 *   NO/HR/PL/SE, plus GB from the `GB_full` dump). Ingest the GeoNames postal dumps → self-ancestors
 *   → indexes → provenance `meta` → VACUUM → FTS/bbox → SEAL.
 *
 *   THIS FILE IS A REPRODUCER, WRITTEN AFTER THE FACT. The shipped artifact (946 MB, 1,895,753 rows,
 *   md5-frozen 2026-07-03) was built by `build-unified-wof --placetypes postalcode
 *   --geonames-postal-countries FI,CZ,SK,SI,DK,NO,HR,PL,SE` — a Phase-2d code path #1027 deleted,
 *   leaving the artifact with no way to rebuild it. Every piece of hard logic survived that deletion
 *   (`ingestGeonamesPostal` and its two #920 laws, `createUnifiedSchema`, `buildPlaceSearchFTS`,
 *   `sealDatabase`); what was lost was the invocation glue, which is what this module is. It is
 *   gated on per-country row-count parity with the frozen artifact — GB 1,839,678 · PL 20,299 ·
 *   SE 18,870 · NO 5,132 · FI 3,576 · SK 3,480 · CZ 2,694 · DK 1,159 · SI 556 · HR 309.
 *
 *   Country ORDER is load-bearing for id reproducibility, not for correctness: `ingestGeonamesPostal`
 *   allocates ids from one counter at {@link GEONAMES_POSTAL_ID_BASE}, so
 *   {@link DEFAULT_GEONAMES_TAIL_COUNTRIES} is written in the frozen artifact's own ingest order
 *   (recovered from its per-country id ranges) and reproduces its ids exactly. File-level md5 identity
 *   is NOT expected — VACUUM page ordering and an additive `names.official` column since 2026-07 both
 *   move bytes without moving a row.
 *
 *   Attribution the frozen artifact never carried, and the reason the `meta` table exists: GeoNames
 *   postal is CC-BY 4.0, and GB rides in from `GB_full`, whose upstream is Ordnance Survey Code-Point
 *   Open — OGL v3, which CC-BY cannot relax. See {@link GB_LICENSE_NOTE} for the receipts and for the
 *   two questions that stay open (the Northern Ireland rows; whether a downstream DB is "derived").
 *   Both licence statements, the per-file md5s, and the build date are baked into the artifact so a
 *   consumer reads them at open instead of trusting a runbook.
 */

import { existsSync, statSync, unlinkSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath, md5File, sealDatabase } from "@mailwoman/core/utils"
import { join } from "path-ts"

import { buildFTS } from "../fts.ts"

/**
 * The frozen artifact's ten countries, IN ITS INGEST ORDER (recovered from its per-country `spr.id` ranges: FI @
 * 9500000000000 … GB @ 9500000056075). The first nine are the #920 namesake-tail set the original
 * `--geonames-postal-countries` flag carried; GB was appended in a later pass from the `GB_full` dump and is 97 % of
 * the artifact (1,839,678 of 1,895,753 rows, ~946 MB). Keep the order: it is what makes a rebuild id-comparable to the
 * frozen shard.
 */
export const DEFAULT_GEONAMES_TAIL_COUNTRIES = ["FI", "CZ", "SK", "SI", "DK", "NO", "HR", "PL", "SE", "GB"] as const

/**
 * `meta` is the artifact's own provenance record — a key/value table read at open, so the licence obligation and the
 * source fingerprints travel WITH the database instead of in a document that can drift from it.
 */
export interface ShardMetaTable {
	key: string
	value: string | null
}

/**
 * Kysely read/write contract for the shard's provenance table.
 */
export interface ShardMetaDatabase {
	meta: ShardMetaTable
}

/**
 * Create the provenance `meta` table. Co-located with {@link ShardMetaDatabase} per the schema-module convention: a
 * column added to one is a compile error against the other.
 */
export async function createShardMetaTable(db: DatabaseSync): Promise<void> {
	const kdb = new DatabaseClient<ShardMetaDatabase>({ database: db })

	await kdb.schema
		.createTable("meta")
		.ifNotExists()
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text")
		.execute()
}

/**
 * What a source dump contributed, fingerprinted. `rows` is the DISTINCT normalized-postcode count (the `spr` rows),
 * which is well below the dump's line count wherever GeoNames carries one row per (postcode, settlement) — PL 72,899
 * lines → 20,299 codes.
 */
export interface GeonamesPostalSourceFact {
	country: string
	file: string
	bytes: number
	md5: string
	rows: number
}

export interface BuildPostcodeGeonamesTailOptions {
	/**
	 * ISO-2 countries to fold, in ingest order. Default {@link DEFAULT_GEONAMES_TAIL_COUNTRIES}.
	 */
	countries?: readonly string[]
	/**
	 * GeoNames postal dump dir holding `<CC>.txt` (download.geonames.org/export/zip). Default
	 * `<data-root>/geonames-postal`.
	 */
	postalDir?: string
	/**
	 * Output artifact. Default `<data-root>/wof/postalcode-geonames-tail-<YYYY-MM-DD>.db` — a NEW dated path every build;
	 * promoting it over the shipped `postalcode-geonames-tail.db` is a deliberate, separate swap.
	 */
	out?: string
	/**
	 * Build clock, stamped into `meta.built_at` and the default output name. Passed in so the module never reads the
	 * clock implicitly (the `defaultGazetteerVersion` convention).
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
	 * Countries whose `<CC>.txt` was absent — reported, not fatal (a partial shard is still a valid shard; the parity
	 * gate is what decides whether it may be promoted).
	 */
	missing: string[]
	sources: GeonamesPostalSourceFact[]
	ancestorRows: number
	ftsRows: number
	bboxRows: number
	sealed: boolean
}

/**
 * `YYYY-MM-DD` in UTC — the dated-artifact suffix.
 */
function datestamp(now: Date): string {
	return now.toISOString().slice(0, 10)
}

/**
 * Build the sealed GeoNames-postal tail shard. See the module docstring for what this reproduces and why the country
 * order matters.
 */
export async function buildPostcodeGeonamesTail(
	opts: BuildPostcodeGeonamesTailOptions = {}
): Promise<BuildPostcodeGeonamesTailResult> {
	const phase = opts.onPhase ?? (() => {})
	const now = opts.now ?? new Date()
	const countries = [...(opts.countries ?? DEFAULT_GEONAMES_TAIL_COUNTRIES)].map((c) => c.toUpperCase())
	const postalDir = opts.postalDir ?? String(dataRootPath("geonames-postal"))
	const out = opts.out ?? String(dataRootPath("wof", `postalcode-geonames-tail-${datestamp(now)}.db`))

	if (!existsSync(postalDir)) {
		throw new Error(
			`buildPostcodeGeonamesTail: no GeoNames postal dir at ${postalDir} — fetch download.geonames.org/export/zip/<CC>.zip`
		)
	}

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { createUnifiedSchema, createUnifiedIndexes, populateAncestors } =
		await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const { ingestGeonamesPostal } = await import("@mailwoman/resolver-wof-sqlite/geonames-postal")

	const ingestPath = out + ".ingest"

	for (const stale of [ingestPath, ingestPath + "-wal", ingestPath + "-shm"]) {
		if (existsSync(stale)) {
			unlinkSync(stale)
		}
	}

	phase("staging", ingestPath)
	const db = new DatabaseSync(ingestPath)

	db.exec(`
		PRAGMA page_size = 8192;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 30000;
		PRAGMA temp_store = MEMORY;
		PRAGMA cache_size = -200000;
	`)

	await createUnifiedSchema(db)

	phase("ingest", `${countries.join(",")} ← ${postalDir}`)
	const ingest = await ingestGeonamesPostal(db, countries, postalDir)
	phase("ingest", `${ingest.inserted.toLocaleString()} distinct postcodes`)

	// Every row's parent_id is -1 (GeoNames postal carries no hierarchy), so this writes the SELF row per
	// place and nothing else. It is not decorative: the resolver's parent-constraint scopes a lookup with
	// `spr.id IN (SELECT id FROM ancestors WHERE ancestor_id = ?)`, and a place absent from `ancestors`
	// can never satisfy it. The frozen artifact carries exactly one ancestor row per place for this reason.
	phase("ancestors")
	const ancestorRows = populateAncestors(db)
	phase("ancestors", `${ancestorRows.toLocaleString()} rows`)

	phase("indexes")
	await createUnifiedIndexes(db)

	phase("meta")
	const sources = await collectSourceFacts(countries, postalDir, ingest.byCountry)
	await writeShardMeta(db, { now, countries, sources, inserted: ingest.inserted })

	phase("freeze")
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	db.exec("PRAGMA journal_mode = DELETE")
	db.exec("ANALYZE")

	phase("vacuum", out)

	if (existsSync(out)) {
		unlinkSync(out)
	}

	db.prepare("VACUUM INTO ?").run(out)
	db.close()

	for (const sidecar of [ingestPath, ingestPath + "-wal", ingestPath + "-shm"]) {
		if (existsSync(sidecar)) {
			unlinkSync(sidecar)
		}
	}

	phase("fts")
	const outDB = new DatabaseSync(out)
	const fts = await buildFTS(outDB, { onProgress: phase })
	outDB.close()

	phase("seal")
	sealDatabase(out)

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
 * Fingerprint each present source dump. A country whose file is missing gets NO fact row rather than a zeroed one — the
 * meaning-of-zero rule: `rows: 0` would read as "measured, empty", which is a different claim from "never present".
 */
async function collectSourceFacts(
	countries: readonly string[],
	postalDir: string,
	byCountry: Record<string, number>
): Promise<GeonamesPostalSourceFact[]> {
	const facts: GeonamesPostalSourceFact[] = []

	for (const country of countries) {
		const file = join(postalDir, `${country}.txt`)

		if (!existsSync(file)) continue

		facts.push({
			country,
			file: `${country}.txt`,
			bytes: statSync(file).size,
			md5: await md5File(file),
			rows: byCountry[country] ?? 0,
		})
	}

	return facts
}

/**
 * The attribution GeoNames' CC-BY 4.0 requires of a redistributor.
 */
const GEONAMES_ATTRIBUTION = "Contains data from GeoNames (geonames.org), © GeoNames contributors, CC-BY 4.0"

/**
 * GB is not plain GeoNames provenance, and GeoNames' own labelling of it is incomplete (researched 2026-08-05).
 *
 * `download.geonames.org/export/zip/readme.txt` puts everything under CC-BY (linking the 3.0 deed while saying 4.0) and
 * adds exactly one GB rider — `UK (GB_full.csv.zip): Contains Royal Mail data Royal Mail copyright and database right
 * 2022` — naming neither Ordnance Survey, Code-Point Open, OGL, nor Crown copyright. GeoNames documents the real source
 * elsewhere: its 2010 announcement (geonames.wordpress.com/2010/04/19/uk-open-public-data) says the GB full codes came
 * from Code-Point Open, and `geonames.org/datasources` row 174 lists GB / Ordnance Survey under `OGLv3.0`. The shipped
 * file agrees — every row carries accuracy 6 and ONS GSS codes.
 *
 * So the binding licence for the GB rows is OGL v3, which CC-BY cannot relax, and the OS attribution block is required
 * of a redistributor. Two gaps stay OPEN and are recorded rather than resolved: (1) GeoNames' GB_full also ships
 * ~48,990 `BT` (Northern Ireland) rows plus IM/GY/JE, territories Code-Point Open does not cover — the 2010 post says
 * only "we continue using the previous data", ONS's OGL grant for postcode products explicitly EXCLUDES Northern
 * Ireland data, and commercial NI use needs a separate Land & Property Services licence; (2) whether a downstream
 * database counts as "derived" for OGL purposes is a counsel question, the same posture `osm/` already sits in. This
 * builder records the facts; it does not make the redistribution decision.
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

interface ShardMetaInput {
	now: Date
	countries: readonly string[]
	sources: readonly GeonamesPostalSourceFact[]
	inserted: number
}

/**
 * Bake the provenance record into the staging DB (pre-VACUUM, pre-seal — a shipped DB is never patched). `sources` is
 * stored as JSON so the per-file md5s stay machine-readable.
 */
async function writeShardMeta(db: DatabaseSync, input: ShardMetaInput): Promise<void> {
	await createShardMetaTable(db)

	const rows: Array<[string, string]> = [
		["name", "mailwoman-postalcode-geonames-tail"],
		[
			"description",
			"GeoNames postal codes as first-class WOF `postalcode` places for the countries without a whosonfirst-data-postalcode repo (#920)",
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
			"#920 laws: `name` stored in the sanitized-query token shape (every non-letter/number stripped) with the display form as an alt `names` row; centroid is the MEDOID member point (never the mean) of the (postcode, settlement) rows",
		],
		["builder", "mailwoman gazetteer build postcode-geonames --countries " + input.countries.join(",")],
		["source_files", JSON.stringify(input.sources)],
	]

	const insert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")

	for (const [key, value] of rows) {
		insert.run(key, value)
	}
}
