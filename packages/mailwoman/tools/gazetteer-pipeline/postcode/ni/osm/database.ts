/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `postalcode-ni-osm-<date>.db` — the Northern Ireland `BT` unit-postcode database from
 *   OpenStreetMap. OSM attests a minority of live NI postcodes.
 *   An absent code abstains from fuzzy matching, so the database is strictly additive.
 *
 *   ODbL 1.0 is share-alike on a Derived Database, so this artifact is build-local and never enters
 *   an npm tarball, an R2 publish, or the demo.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { md5File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { LayerTier } from "@mailwoman/core/layers"
import { repoRootPath } from "@mailwoman/core/paths"
import { NI_OSM_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { isoDate } from "@mailwoman/core/utils"
import { OSM_ATTRIBUTION, OSM_LICENSE_URL } from "@mailwoman/corpus/adapters/osm/adapter"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed/db"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import {
	applyStagingPragmas,
	buildDatabaseFTS,
	freezeStagingDatabase,
	readAcquisitionSidecar,
	removeStagingArtifacts,
	UNKNOWN_PROVENANCE,
	vacuumDatabaseInto,
} from "#gazetteer/database-lifecycle"
import type { BuildFTSResult } from "#gazetteer/fts"
import type { DatabaseMetaDatabase } from "#gazetteer/postcode/geonames/tail"
import { createDatabaseMetaTable, writeMetaRows } from "#gazetteer/postcode/geonames/tail"
import {
	acquireNIPostcodes,
	createNIOSMParseStats,
	NI_OSM_BUILD_LOCAL_NOTE,
	NI_POSTCODE_OVERPASS_QUERY,
	type NIAcquisitionSidecar,
	type NIOSMParseStats,
	type NIPostcodeRecord,
	niPostcodeQueryMD5,
	OSM_LICENSE,
	type OverpassResponse,
	parseNIPostcodes,
} from "#gazetteer/postcode/ni/osm"
import { buildSHA, foldLayerManifest, stampLayerManifest } from "#gazetteer/stamp-manifest"

/**
 * ISO-3166-1 alpha-2 stamped on every row.
 *
 * Northern Ireland is part of the United Kingdom.
 * `pickExtractForPlacetype` routes on country, so the postcode area (`BT`) must include
 * the distinction between Northern Ireland and Great Britain.
 */
const COUNTRY = "GB"

/**
 * Live NI postcodes per onspd Feb 2025 — the denominator the coverage fraction is stated against.
 */
export const NI_LIVE_POSTCODES = 50_032

/**
 * Total NI postcode sectors — an outward code plus one inward digit (`BT3 9`).
 *
 * Distinct from {@link NI_LIVE_POSTCODES}: a database can cover a sector without covering its units.
 */
export const NI_TOTAL_SECTORS = 886

/**
 * Total NI postcode districts — the outward code by itself (`BT3`), i.e. `BT1`–`BT94` with the gaps removed.
 */
export const NI_TOTAL_DISTRICTS = 80

export interface BuildPostcodeNIOSMOptions {
	/**
	 * Acquisition directory holding (or to hold) `response.json` + `acquisition.json`.
	 *
	 * Default `<data-root>/osm-ni-postcodes/<yyyy-MM-DD>` — a new dated directory per acquisition.
	 */
	sourceDir?: PathBuilderLike
	/**
	 * Output artifact.
	 *
	 * Default `<data-root>/db/wof/postalcode-ni-osm-<yyyy-MM-DD>.db` — a new dated path every build.
	 * A separate step copies it to the canonical `postalcode-ni-osm.db`.
	 */
	out?: PathBuilderLike
	/**
	 * Skip the network and use whatever is already in `sourceDir`; fails if `response.json` is absent.
	 *
	 * Rebuilds use this so the saved response remains the reproducibility artifact.
	 */
	offline?: boolean
	/**
	 * Build clock stamped into `meta.built_at` and the default paths,
	 * so the module never reads the clock implicitly.
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
	 * The OSM data extract the response reflects (`osm3s.timestamp_osm_base`) —
	 * the real provenance date, as against the wall-clock retrieval time.
	 */
	osmTimestamp: string
	/**
	 * Every unreconciled row represents a drop that the counters cannot account for, or a district/sector
	 * count above the national total (which would mean the validator is admitting non-NI codes).
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
	const sourceDir = PathBuilder.from(options.sourceDir ?? dataRootPath("osm-ni-postcodes", stamp))
	const out = (options.out ?? wofDatabasePath(`postalcode-ni-osm-${stamp}.db`)).toString()
	const responsePath = sourceDir("response.json")

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

	// The saved query is authoritative over the module constant, so the database records
	// the query that produced its bytes rather than the query the code would issue today.
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

	// Imported lazily so loading this module does not evaluate resolver-wof-sqlite.
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

		// Hot positional INSERTs — raw prepared statements, per the agents.md bulk-load carve-out.
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

			// Degenerate bbox — a unit postcode is a point here rather than a polygon.
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

			// The name law: the sanitized form is the name, the display form is an alt.
			if (record.display !== record.name) {
				namesInsert.run(id, record.display)
			}

			inserted++
		}

		db.exec("COMMIT")

		// Every row's parent_id is -1, so this writes only the self row.
		// The resolver's parent constraint scopes a lookup with
		// `spr.id IN (select id from ancestors where ancestor_id = ?)`, and a place
		// absent from `ancestors` can never satisfy it.
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

	// The layer interface's manifest, beside the `meta` record and stating the same tier.
	phase("layer-manifest")

	await stampLayerManifest(
		out,
		foldLayerManifest({
			name: "postalcode-ni-osm",
			version: stamp,
			// ODbL 1.0 is share-alike on a Derived Database.
			tier: LayerTier.BuildLocal,
			license: OSM_LICENSE,
			attribution: OSM_ATTRIBUTION,
			source: "OpenStreetMap via the Overpass API",
			sourceVintage: osmTimestamp,
			buildCmd: "mailwoman gazetteer build postcode-ni-osm",
			buildSHA: buildSHA(repoRootPath()),
			createdAt: now.toISOString(),
			spineKeys: { wofID: "id" },
		})
	)

	phase("seal")
	await sealDatabase(out)

	return {
		out,
		sourceDir: sourceDir.toString(),
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
 * Check identities that no single counter implies.
 *
 * Every tagged element is a point or an accounted drop.
 * Districts and sectors stay within the national totals.
 *
 * Every record has at least one attestation, so zero means "not in OSM"
 * rather than "in OSM with no evidence".
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
 * Bake the provenance record into the staging DB before vacuum and seal.
 * A shipped DB is never patched.
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
		// The OSM extract date.
		// It matters more than `source_retrieved_at`, which records when we asked.
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
			stringifyJSON({
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
