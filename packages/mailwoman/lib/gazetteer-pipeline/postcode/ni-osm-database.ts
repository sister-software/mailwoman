/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `postalcode-ni-osm-<date>.db` — the Northern Ireland `BT` unit-postcode database from
 *   OpenStreetMap, and the only coverage that exists for the hole Code-Point Open leaves.
 *
 *   ## Why this database exists, and why it is partial ON PURPOSE
 *
 *   `../codepoint/fetch.ts`'s `NORTHERN_IRELAND_OPTIONS_NOTE` researched the `BT` gap and found three
 *   options: (a) licence LPS Pointer for ~£9,224, (b) take OSM `addr:postcode` under ODbL, (c) ship
 *   nothing. Every free, complete, permissively-licensed source was checked and ruled out — ONSPD and
 *   NSPL carve NI out of their OGL grant in ONS's own words, the LPS End User Licence is personal and
 *   non-sublicensable, and LPS's 77-dataset OSNI Open Data catalogue contains no postcode centroids at
 *   all. So the choice is (a), (b) or nothing, and this is (b).
 *
 *   OSM attests 4,757 of the 50,032 live NI postcodes — **9.5 %**. That is not a defect to be improved
 *   away; it is what volunteer mapping has recorded, and the number is baked into the artifact's `meta`
 *   so nobody reads a miss as a data error.
 *
 *   ## Why a partial database is strictly additive
 *
 *   Since #1480 an unknown postcode ABSTAINS rather than fuzzy-matching, so a `BT` code this database does
 *   not carry behaves exactly as it does today — no answer — while a code it does carry now resolves.
 *   There is no input for which adding this database produces a WRONG answer where it previously produced
 *   a right one. That property is what makes 9.5 % worth shipping at all.
 *
 *   ## Tier: BUILD-LOCAL
 *
 *   ODbL 1.0 is share-alike on a Derived Database, and mailwoman's shipped gazetteer is assembled from
 *   permissive sources precisely so that installing the package imposes no share-alike obligation.
 *   This artifact therefore never enters an npm tarball, an R2 publish, or the demo — it is built on the
 *   operator's machine and picked up because `DEFAULT_POSTCODE_DATABASES` is `existsSync`-filtered, which
 *   IS the build-local mechanism. See `NI_OSM_BUILD_LOCAL_NOTE`. Same posture as `poi.db` and
 *   `@mailwoman/osm`.
 *
 *   ## What is shared with the other postcode builders
 *
 *   Everything except the read side: the unified schema, `normalizePostcodeName` and `medoidPoint` (the
 *   two #920 laws), `populateAncestors`, `buildFTS`, `createDatabaseMetaTable`, `sealDatabase`. This file
 *   is `codepoint-database.ts` with an Overpass-JSON reader in place of a CSV one.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { md5File } from "@mailwoman/core/hash"
import { isoDate } from "@mailwoman/core/utils"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { join } from "path-ts"

import {
	applyStagingPragmas,
	buildDatabaseFTS,
	freezeStagingDatabase,
	readAcquisitionSidecar,
	removeStagingArtifacts,
	UNKNOWN_PROVENANCE,
	vacuumDatabaseInto,
} from "#gazetteer-pipeline/database-lifecycle"
import type { BuildFTSResult } from "#gazetteer-pipeline/fts"
import type { DatabaseMetaDatabase } from "#gazetteer-pipeline/postcode/geonames-tail"
import { createDatabaseMetaTable, writeMetaRows } from "#gazetteer-pipeline/postcode/geonames-tail"
import {
	acquireNIPostcodes,
	createNIOSMParseStats,
	NI_OSM_BUILD_LOCAL_NOTE,
	NI_POSTCODE_OVERPASS_QUERY,
	type NIAcquisitionSidecar,
	type NIOSMParseStats,
	type NIPostcodeRecord,
	niPostcodeQueryMD5,
	OSM_ATTRIBUTION,
	OSM_LICENSE,
	OSM_LICENSE_URL,
	type OverpassResponse,
	parseNIPostcodes,
} from "#gazetteer-pipeline/postcode/ni-osm/index"

/**
 * Synthetic id base for the NI OSM rows — its own namespace above Code-Point Open (9.7e12), so every postcode source
 * coexists collision-free if a combined DB ever attaches them together.
 *
 * The registry, in allocation order, so the next author picks 9.9e12 rather than re-deriving it:
 *
 * - `8.0e12` — `OVERTURE_ID_BASE` (`../admin/fold-overture.ts`)
 * - `9.0e12` — `GEONAMES_ID_BASE`, the alias fold (`@mailwoman/resolver-wof-sqlite/geonames-aliases`)
 * - `9.5e12` — `GEONAMES_POSTAL_ID_BASE` (`@mailwoman/resolver-wof-sqlite/geonames-postal`)
 * - `9.6e12` — `NL_PC6_ID_BASE` (`./nl-pc6.ts`)
 * - `9.7e12` — `CODEPOINT_ID_BASE` (`./codepoint-database.ts`)
 * - `9.8e12` — **this database**
 *
 * Each range holds 100 billion ids against a largest-ever occupancy of 1.75 M (Code-Point Open), so the spacing is not
 * the constraint — the registry is, which is why it is written down at every base rather than in one file that the
 * others would have to be read to find.
 */
export const NI_OSM_ID_BASE = 9_800_000_000_000

/**
 * ISO-3166-1 alpha-2 stamped on every row. Northern Ireland is part of the United Kingdom, so `spr.country` is `GB` —
 * the same value the Code-Point Open database writes. The NI-vs-GB distinction lives in the postcode area itself
 * (`BT`), not in the country column, and the database routing (`pickExtractForPlacetype`) keys on country, so writing
 * anything else here would take this database out of GB postcode routing entirely.
 */
const COUNTRY = "GB"

/**
 * Live NI postcodes per ONSPD Feb 2025 — the denominator the coverage fraction is stated against. Sourced in
 * `../codepoint/fetch.ts`'s `NORTHERN_IRELAND_OPTIONS_NOTE`.
 */
export const NI_LIVE_POSTCODES = 50_032

/**
 * Total NI postcode SECTORS — an outward code plus one inward digit (`BT3 9`). The coarser denominator: a database can
 * cover a sector without covering many of its units, so this number and {@link NI_LIVE_POSTCODES} answer different
 * questions and both are reported.
 */
export const NI_TOTAL_SECTORS = 886

/**
 * Total NI postcode DISTRICTS — the outward code alone (`BT3`), i.e. `BT1`–`BT94` with the gaps removed. The coarsest
 * denominator, and the one the OSM database saturates: 80 of 80.
 */
export const NI_TOTAL_DISTRICTS = 80

export interface BuildPostcodeNIOSMOptions {
	/**
	 * Acquisition directory holding (or to hold) `response.json` + `acquisition.json`. Default
	 * `<data-root>/osm-ni-postcodes/<YYYY-MM-DD>` — a NEW dated directory per acquisition.
	 */
	sourceDir?: string
	/**
	 * Output artifact. Default `<data-root>/wof/postalcode-ni-osm-<YYYY-MM-DD>.db` — a NEW dated path every build.
	 * Copying it to the canonical `postalcode-ni-osm.db` is a deliberate, separate step.
	 */
	out?: string
	/**
	 * Skip the network entirely and use whatever is already in `sourceDir`. Fails if `response.json` is not there. This
	 * is the NORMAL mode for a rebuild: the saved response is the reproducibility artifact, and re-querying a volunteer
	 * endpoint to rebuild the same database is what the dated directory exists to avoid.
	 */
	offline?: boolean
	/**
	 * Build clock — stamped into `meta.built_at` and the default paths. Passed in so the module never reads the clock
	 * implicitly (the `defaultGazetteerVersion` convention).
	 */
	now?: Date
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildPostcodeNIOSMResult {
	out: string
	sourceDir: string
	/**
	 * Distinct unit postcodes written.
	 */
	inserted: number
	stats: NIOSMParseStats
	/**
	 * Distinct districts and sectors the database covers, against the national totals.
	 */
	districts: number
	sectors: number
	/**
	 * Md5 of the response file the build read.
	 */
	responseMD5: string
	/**
	 * Md5 of the query text that produced it.
	 */
	queryMD5: string
	/**
	 * The OSM data extract the response reflects (`osm3s.timestamp_osm_base`) — the real provenance date, as against the
	 * wall-clock retrieval time.
	 */
	osmTimestamp: string
	/**
	 * Anything that failed to reconcile: a drop the counters cannot account for, or a district/sector count above the
	 * national total (which would mean the validator is admitting non-NI codes).
	 */
	reconciliationFailures: string[]
	ancestorRows: number
	ftsRows: number
	bboxRows: number
	sealed: boolean
}

/**
 * Build the sealed NI OSM postcode database.
 */
export async function buildPostcodeNIOSM(options: BuildPostcodeNIOSMOptions = {}): Promise<BuildPostcodeNIOSMResult> {
	const phase = options.onPhase ?? (() => {})
	const now = options.now ?? new Date()
	const stamp = isoDate(now)
	const sourceDir = options.sourceDir ?? String(dataRootPath("osm-ni-postcodes", stamp))
	const out = options.out ?? String(dataRootPath("wof", `postalcode-ni-osm-${stamp}.db`))
	const responsePath = String(join(sourceDir, "response.json"))

	// --- Acquire. Offline is the normal path; see the option's docstring.
	if (!options.offline) {
		await acquireNIPostcodes({ destDir: sourceDir, now, onPhase: phase })
	}

	if (!(await pathExists(responsePath))) {
		throw new Error(
			`buildPostcodeNIOSM: no Overpass response at ${responsePath} — run without --offline to acquire it, ` +
				`or copy an existing dated acquisition into place.`
		)
	}

	const responseMD5 = await md5File(responsePath)
	const sidecar = await readAcquisitionSidecar<NIAcquisitionSidecar>(sourceDir)

	// The saved query is authoritative over the module constant: the database must record the query that
	// produced ITS bytes, not the query the code would issue today. They diverge the moment the constant
	// is edited, and the whole point of the sidecar is to survive that edit.
	const queryText = sidecar?.query ?? NI_POSTCODE_OVERPASS_QUERY
	const queryMD5 = sidecar?.queryMD5 ?? niPostcodeQueryMD5()
	const retrievedAt = sidecar?.retrievedAt ?? UNKNOWN_PROVENANCE
	const endpoint = sidecar?.endpoint ?? UNKNOWN_PROVENANCE

	if (sidecar && sidecar.md5 !== responseMD5) {
		throw new Error(
			`buildPostcodeNIOSM: ${responsePath} hashes to ${responseMD5} but acquisition.json records ${sidecar.md5} — ` +
				`the response has been modified since acquisition. Re-acquire into a NEW dated directory rather than ` +
				`building from bytes whose provenance no longer describes them.`
		)
	}

	phase("read", `${responsePath} (md5 ${responseMD5})`)
	const response = await readLocalJSONFile<OverpassResponse>(responsePath)
	const osmTimestamp = response.osm3s?.timestamp_osm_base ?? UNKNOWN_PROVENANCE

	const stats = createNIOSMParseStats()
	const records = parseNIPostcodes(response, stats)

	phase(
		"parse",
		`${stats.elements.toLocaleString()} elements → ${records.length.toLocaleString()} unit postcodes ` +
			`(${stats.skippedMalformed} malformed, ${stats.skippedNoCoordinate} no-coordinate)`
	)

	const districts = new Set(records.map((r) => r.district))
	const sectors = new Set(records.map((r) => r.sector))
	const reconciliationFailures = reconcile(stats, records, districts.size, sectors.size)

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { createUnifiedSchema, createUnifiedIndexes, populateAncestors } =
		await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const ingestPath = `${out}.ingest`
	await removeStagingArtifacts(ingestPath)

	phase("staging", ingestPath)

	let inserted = 0

	let ancestorRows: number

	{
		using db = new DatabaseClient<WOFDatabase>(ingestPath)

		applyStagingPragmas(db)

		await createUnifiedSchema(db)

		// Hot positional INSERTs — raw prepared statements, per the AGENTS.md bulk-load carve-out.
		const sprInsert = db.prepare(
			`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, -1, ?, 'postalcode', '${COUNTRY}', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
		)

		const namesInsert = db.prepare(
			`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'postalcode', '${COUNTRY}', '', 0)`
		)

		phase("ingest", `${records.length.toLocaleString()} unit postcodes`)
		db.exec("BEGIN")

		for (const record of records) {
			const id = NI_OSM_ID_BASE + inserted

			// Degenerate bbox — a unit postcode is a point here, not a polygon.
			sprInsert.run(
				id,
				record.name,
				record.latitude,
				record.longitude,
				record.latitude,
				record.longitude,
				record.latitude,
				record.longitude
			)

			namesInsert.run(id, record.name)

			// The #920 name law: the sanitized form is the NAME, the display form is an alt.
			if (record.display !== record.name) {
				namesInsert.run(id, record.display)
			}

			inserted++
		}

		db.exec("COMMIT")

		// Every row's parent_id is -1 (OSM address points carry no WOF hierarchy), so this writes the SELF row
		// per place and nothing else. Not decorative: the resolver's parent-constraint scopes a lookup with
		// `spr.id IN (SELECT id FROM ancestors WHERE ancestor_id = ?)`, and a place absent from `ancestors` can
		// never satisfy it.
		phase("ancestors")
		ancestorRows = populateAncestors(db)

		phase("indexes")
		await createUnifiedIndexes(db)

		phase("meta")

		await writeDatabaseMeta(db, {
			now,
			stats,
			inserted,
			districts: districts.size,
			sectors: sectors.size,
			responseMD5,
			queryText,
			queryMD5,
			retrievedAt,
			endpoint,
			osmTimestamp,
			reconstructedProvenance: sidecar?.reconstructed === true,
		})

		phase("freeze")
		freezeStagingDatabase(db)

		phase("vacuum", out)
		await vacuumDatabaseInto(db, out)
	}

	await removeStagingArtifacts(ingestPath)

	phase("fts")

	const fts: BuildFTSResult = await buildDatabaseFTS(out, (path) => new DatabaseClient<WOFDatabase>(path), phase)

	phase("seal")
	await sealDatabase(out)

	return {
		out,
		sourceDir,
		inserted,
		stats,
		districts: districts.size,
		sectors: sectors.size,
		responseMD5,
		queryMD5,
		osmTimestamp,
		reconciliationFailures,
		ancestorRows,
		ftsRows: fts.ftsRows,
		bboxRows: fts.bboxRows,
		sealed: true,
	}
}

/**
 * Check the identities that no single counter implies.
 *
 * There is no upstream manifest here — OSM does not publish "this many BT-tagged elements exist" — so unlike the
 * Code-Point Open build there is no external oracle to condition on. What CAN be checked is internal consistency plus
 * two bounds that a broken validator would blow through, and those are worth more than they look: the
 * `codepoint-database.ts` check learned the hard way that a tolerance derived from the failure it is meant to catch
 * catches nothing, so every check here is against a fixed number.
 *
 * 1. Every tagged element is either a point or an accounted drop. A parser that silently skips a shape fails here.
 * 2. Districts ≤ 80 and sectors ≤ 886, the national totals. Exceeding either means the validator is admitting codes that
 *    are not NI — the failure mode of loosening {@link NI_UNIT_POSTCODE} to make more rows pass.
 * 3. Every record has at least one attestation, so a zero can only mean "not in OSM", never "in OSM with no evidence".
 */
function reconcile(
	stats: NIOSMParseStats,
	records: readonly NIPostcodeRecord[],
	districts: number,
	sectors: number
): string[] {
	const failures: string[] = []
	const accounted = stats.points + stats.skippedMalformed + stats.skippedNoCoordinate

	if (accounted !== stats.tagged) {
		failures.push(
			`TAGGED: ${stats.tagged} tagged elements but points ${stats.points} + malformed ${stats.skippedMalformed} + ` +
				`no-coordinate ${stats.skippedNoCoordinate} = ${accounted}`
		)
	}

	if (districts > NI_TOTAL_DISTRICTS) {
		failures.push(`DISTRICTS: ${districts} distinct districts exceeds the national total of ${NI_TOTAL_DISTRICTS}`)
	}

	if (sectors > NI_TOTAL_SECTORS) {
		failures.push(`SECTORS: ${sectors} distinct sectors exceeds the national total of ${NI_TOTAL_SECTORS}`)
	}

	if (records.length > NI_LIVE_POSTCODES) {
		failures.push(`UNITS: ${records.length} unit postcodes exceeds the ${NI_LIVE_POSTCODES} live NI postcodes`)
	}

	const unattested = records.filter((r) => r.attestations < 1).length

	if (unattested) {
		failures.push(`ATTESTATION: ${unattested} records carry no member point`)
	}

	return failures
}

interface DatabaseMetaInput {
	now: Date
	stats: NIOSMParseStats
	inserted: number
	districts: number
	sectors: number
	responseMD5: string
	queryText: string
	queryMD5: string
	retrievedAt: string
	endpoint: string
	osmTimestamp: string
	reconstructedProvenance: boolean
}

/**
 * Bake the provenance record into the staging DB (pre-VACUUM, pre-seal — a shipped DB is never patched).
 */
async function writeDatabaseMeta<DB extends DatabaseMetaDatabase>(
	db: DatabaseClient<DB>,
	input: DatabaseMetaInput
): Promise<void> {
	await createDatabaseMetaTable(db)

	const pct = ((input.inserted / NI_LIVE_POSTCODES) * 100).toFixed(1)

	const rows: Array<[string, string]> = [
		["name", "mailwoman-postalcode-ni-osm"],
		[
			"description",
			"Northern Ireland BT unit postcodes from OpenStreetMap `addr:postcode` as first-class WOF `postalcode` places",
		],
		["schema_version", "1"],
		["built_at", input.now.toISOString()],
		["countries", COUNTRY],
		["postcode_rows", String(input.inserted)],
		["source", "OpenStreetMap via the Overpass API"],
		["source_endpoint", input.endpoint],
		["source_query", input.queryText],
		["source_query_md5", input.queryMD5],
		["source_response_md5", input.responseMD5],
		["source_retrieved_at", input.retrievedAt],
		// The DATA extract, which is the date that matters — `source_retrieved_at` only says when we asked.
		["source_osm_timestamp", input.osmTimestamp],
		["license", OSM_LICENSE],
		["license_url", OSM_LICENSE_URL],
		["attribution", OSM_ATTRIBUTION],
		["tier", "build-local"],
		["tier_reason", NI_OSM_BUILD_LOCAL_NOTE],
		[
			"coverage",
			`${input.inserted} of ${NI_LIVE_POSTCODES} live Northern Ireland postcodes (${pct} %), across ` +
				`${input.districts} of ${NI_TOTAL_DISTRICTS} postcode districts and ${input.sectors} of ` +
				`${NI_TOTAL_SECTORS} sectors, as attested by OpenStreetMap on ${input.osmTimestamp}. PARTIAL BY ` +
				`CONSTRUCTION — see coverage_meaning_of_zero.`,
		],
		[
			"coverage_meaning_of_zero",
			"A miss on a BT postcode in this database means NOT ATTESTED IN OPENSTREETMAP. It does NOT mean the postcode " +
				"does not exist, and it does NOT mean the postcode is invalid. Roughly nine in ten live NI postcodes are " +
				"absent, because this is volunteer-mapped address data and not a postal register. Since #1480 an unknown " +
				"postcode abstains rather than fuzzy-matching, so an absent code behaves exactly as it did before this " +
				"database existed — the database is strictly additive and cannot turn a right answer into a wrong one.",
		],
		[
			"coverage_gap_reason",
			"The complete NI postcode register (LPS Pointer, ~1 M address points) is licensable from Land & Property " +
				"Services at ~£9,224 excl. VAT and is the ONLY route to full NI coverage in a permissively-licensed " +
				"package. ONSPD/NSPL carry BT coordinates but ONS excludes Northern Ireland data from its OGL grant, and " +
				"the LPS End User Licence that governs those rows is personal, internal-use-only and non-sublicensable. " +
				"See NORTHERN_IRELAND_OPTIONS_NOTE in the Code-Point Open acquisition module for the full research.",
		],
		[
			"method",
			"#920 laws: `name` stored in the sanitized-query token shape (every non-letter/number stripped) with the " +
				"single-space display form as an alt `names` row; the centroid is the MEDOID member point (never the mean) " +
				"of every OSM element attesting that postcode, so the coordinate stays on a real mapped address. Elements " +
				"are nodes, ways and relations alike (`out center` collapses each to one point). Values that are not a BT " +
				"unit postcode are DROPPED and counted, never repaired.",
		],
		[
			"quality_drops",
			JSON.stringify({
				elements: input.stats.elements,
				tagged: input.stats.tagged,
				points: input.stats.points,
				pointsByType: input.stats.pointsByType,
				skippedNoCoordinate: input.stats.skippedNoCoordinate,
				skippedMalformed: input.stats.skippedMalformed,
				malformedValues: input.stats.malformedValues,
			}),
		],
		["builder", "mailwoman gazetteer build postcode-ni-osm"],
	]

	if (input.reconstructedProvenance) {
		rows.push([
			"source_provenance_note",
			"The acquisition sidecar was RECONSTRUCTED from the response file's mtime rather than recorded at request " +
				"time, so `source_retrieved_at` is when those bytes were written to disk. The response md5 and the OSM " +
				"data timestamp are first-hand either way.",
		])
	}

	writeMetaRows(db, rows)
}
