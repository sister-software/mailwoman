/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `postalcode-gb-codepoint-<date>.db` from Ordnance Survey Code-Point Open, the licensed
 *   replacement for the GeoNames `GB_full` rows in `postalcode-geonames-tail.db`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { type LayerManifest, LayerTier } from "@mailwoman/core/layers"
import { repoRootPath } from "@mailwoman/core/paths"
import { CODEPOINT_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { isoDate } from "@mailwoman/core/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { PathBuilder, type PathBuilderLike } from "path-ts"

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
import {
	CODEPOINT_COVERAGE_NOTE,
	CODEPOINT_LICENSE,
	CODEPOINT_LICENSE_URL,
	NORTHERN_IRELAND_OPTIONS_NOTE,
	type CodePointMetadata,
	type CodePointParseStats,
	codePointAttribution,
	createCodePointParseStats,
	downloadCodePointOpen,
	extractCodePointOpen,
	readCodePointCSV,
} from "#gazetteer-pipeline/postcode/codepoint/index"
import { createDatabaseMetaTable, writeMetaRows } from "#gazetteer-pipeline/postcode/geonames/tail"
import { buildSHA, foldLayerManifest, stampLayerManifest } from "#gazetteer-pipeline/stamp-manifest"

/**
 * The year the attribution block names, taken from OS's own `copyright date` rather than the build clock,
 * with the build clock standing in only when the archive's metadata has no date.
 */
function attributionYear(metadata: CodePointMetadata, now: Date): number {
	return Number(metadata.copyrightDate.slice(0, 4)) || now.getUTCFullYear()
}

/**
 * Compose the artifact's `layer_manifest` from the release it reproduces, at the `shipped` tier
 * because OGL v3 requires attribution and has no share-alike term.
 */
export function codePointLayerManifest(input: {
	osVersion: string
	metadata: CodePointMetadata
	now: Date
}): LayerManifest {
	return foldLayerManifest({
		name: "postalcode-gb-codepoint",
		version: input.osVersion,
		tier: LayerTier.Shipped,
		license: CODEPOINT_LICENSE,
		attribution: codePointAttribution(attributionYear(input.metadata, input.now)),
		source: "Ordnance Survey Code-Point Open",
		sourceVintage: `${input.osVersion} (dataset ${input.metadata.datasetVersion}, copyright ${input.metadata.copyrightDate})`,
		buildCmd: "mailwoman gazetteer build postcode-codepoint",
		buildSHA: buildSHA(repoRootPath()),
		createdAt: input.now.toISOString(),
		spineKeys: { wofID: "id" },
	})
}

/**
 * ISO-3166-1 alpha-2 stamped on every row.
 *
 * Code-Point Open covers Great Britain only.
 * `spr.country` uses the country code `GB`, not ONS codes for England, Scotland, or Wales.
 */
const COUNTRY = "GB"

export interface BuildPostcodeCodePointOptions {
	/**
	 * Acquisition directory holding (or to hold) `codepo_gb.zip` and its extracted
	 * `Data/CSV` tree, defaulting to `<data-root>/codepoint/<yyyy-MM-DD>`.
	 */
	sourceDir?: PathBuilderLike
	/**
	 * Output artifact, defaulting to `<data-root>/db/wof/postalcode-gb-codepoint-<yyyy-MM-DD>.db`;
	 * promoting it into `DEFAULT_POSTCODE_DATABASES` is a deliberate, separate swap.
	 */
	out?: PathBuilderLike
	/**
	 * Skip the network entirely and use whatever is already in `sourceDir`,
	 * failing if the CSVs are not there.
	 */
	offline?: boolean
	/**
	 * Build clock — stamped into `meta.built_at` and the default paths, passed in so the
	 * module never reads the clock implicitly (the `defaultGazetteerVersion` convention).
	 */
	now?: Date
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildPostcodeCodePointResult {
	out: string
	sourceDir: string
	/**
	 * Distinct unit postcodes written.
	 */
	inserted: number
	/**
	 * Rows read and dropped, with the reason, as {@link CodePointParseStats}.
	 */
	stats: CodePointParseStats
	/**
	 * The archive's own manifest, the row-count oracle this build is conditioned on.
	 */
	metadata: CodePointMetadata
	/**
	 * Areas whose parsed count differs from the manifest, as `area: manifest→parsed`,
	 * empty when every area agrees after accounting for the no-coordinate drops.
	 */
	manifestMismatches: string[]
	ancestorRows: number
	ftsRows: number
	bboxRows: number
	archiveMD5: string
	osVersion: string
	sealed: boolean
}

/**
 * The sidecar {@link downloadCodePointOpen} writes beside the archive.
 */
interface AcquisitionSidecar {
	product?: { version?: string }
	md5?: string
}

/**
 * Build the sealed GB Code-Point Open postcode database.
 */
export async function buildPostcodeCodePoint(
	options: BuildPostcodeCodePointOptions = {}
): Promise<BuildPostcodeCodePointResult> {
	const phase = options.onPhase ?? (() => {})
	const now = options.now ?? new Date()
	const stamp = isoDate(now)
	const sourceDir = PathBuilder.from(options.sourceDir ?? dataRootPath("codepoint", stamp))
	const out = (options.out ?? wofDatabasePath(`postalcode-gb-codepoint-${stamp}.db`)).toString()

	// An offline build must not record blank provenance.
	// The `acquisition.json` sidecar supplies the release label and MD5.
	// The build records a missing sidecar in words rather than an empty string.
	let archiveMD5: string
	let osVersion: string

	if (options.offline) {
		const sidecar = await readAcquisitionSidecar<AcquisitionSidecar>(sourceDir)

		archiveMD5 = sidecar?.md5 ?? UNKNOWN_PROVENANCE
		osVersion = sidecar?.product?.version ?? UNKNOWN_PROVENANCE

		phase(
			"offline",
			sidecar ? `provenance from acquisition.json (${osVersion})` : "NO acquisition.json — provenance unknown"
		)
	} else {
		const download = await downloadCodePointOpen({ destDir: sourceDir, onPhase: phase })

		archiveMD5 = download.md5
		osVersion = download.version
	}

	const archivePath = sourceDir("codepo_gb.zip")
	const extracted = await extractCodePointOpen({ archivePath, destDir: sourceDir, onPhase: phase })

	phase(
		"manifest",
		`${extracted.metadata.totalRows.toLocaleString()} rows claimed across ${extracted.csvPaths.length} areas`
	)

	// Imported here so loading this module does not evaluate resolver-wof-sqlite (the gazetteer-pipeline convention).
	const { createUnifiedSchema, createUnifiedIndexes, populateAncestors } =
		await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const { normalizePostcodeName } = await import("@mailwoman/resolver-wof-sqlite/geonames")

	const ingestPath = `${out}.ingest`
	await removeStagingArtifacts(ingestPath)

	phase("staging", ingestPath)

	let inserted = 0
	const stats = createCodePointParseStats()
	const manifestMismatches = compareAgainstManifest(extracted.metadata, stats)

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

		phase("ingest", `${extracted.csvPaths.length} area CSVs`)
		db.exec("BEGIN")

		for (const csvPath of extracted.csvPaths) {
			for await (const record of readCodePointCSV(csvPath, stats)) {
				// Name law: sanitized form is the name, display form is an alt.
				const name = normalizePostcodeName(record.postcode)
				const id = CODEPOINT_ID_BASE + inserted

				// Degenerate bbox — a unit postcode is a point in this product rather than a polygon.
				sprInsert.run(
					id,
					name,
					record.latitude,
					record.longitude,
					record.latitude,
					record.longitude,
					record.latitude,
					record.longitude
				)

				namesInsert.run(id, name)

				if (record.postcode !== name) {
					namesInsert.run(id, record.postcode)
				}

				inserted++
			}
		}

		db.exec("COMMIT")
		phase("ingest", `${inserted.toLocaleString()} unit postcodes`)

		// Every row's parent_id is -1, so this writes the self row per place.
		// The resolver's parent-constraint reads `ancestors`, and a place absent from it can never satisfy it.
		phase("ancestors")
		ancestorRows = populateAncestors(db)

		phase("indexes")
		await createUnifiedIndexes(db)

		phase("meta")

		await writeDatabaseMeta(db, {
			now,
			stats,
			metadata: extracted.metadata,
			inserted,
			archiveMD5,
			osVersion,
			extracted,
		})

		phase("freeze")
		freezeStagingDatabase(db)

		phase("vacuum", out)
		await vacuumDatabaseInto(db, out)
	}

	await removeStagingArtifacts(ingestPath)

	phase("fts")

	const fts: BuildFTSResult = await buildDatabaseFTS(out, (path) => new DatabaseClient<WOFDatabase>(path), phase)

	// The layer interface's manifest beside the `meta` record.
	// The candidate build reads its tier before folding the database.
	phase("layer-manifest")
	await stampLayerManifest(out, codePointLayerManifest({ osVersion, metadata: extracted.metadata, now }))

	phase("seal")
	await sealDatabase(out)

	return {
		out,
		sourceDir: sourceDir.toString(),
		inserted,
		stats,
		metadata: extracted.metadata,
		manifestMismatches,
		ancestorRows,
		ftsRows: fts.ftsRows,
		bboxRows: fts.bboxRows,
		archiveMD5,
		osVersion,
		sealed: true,
	}
}

/**
 * Compare per-area parsed counts against the archive's `Doc/metadata.txt` manifest, where the
 * identity is `manifest[area] === parsed[area] + noCoordinateDrops[area]` and the tolerance is
 * only the no-coordinate drops so a malformed row cannot widen the slack it is meant to catch.
 */
function compareAgainstManifest(metadata: CodePointMetadata, stats: CodePointParseStats): string[] {
	const mismatches: string[] = []
	const tolerance = stats.skippedNoCoordinate

	for (const [area, expected] of Object.entries(metadata.rowsByArea)) {
		const actual = stats.yieldedByArea[area] ?? 0

		if (actual > expected || expected - actual > tolerance) {
			mismatches.push(`${area}: manifest ${expected} → parsed ${actual}`)
		}
	}

	for (const area of Object.keys(stats.yieldedByArea)) {
		if (!(area in metadata.rowsByArea)) {
			mismatches.push(`${area}: parsed ${stats.yieldedByArea[area]} but ABSENT from manifest`)
		}
	}

	// The national identity no per-area check implies: every manifest row is yielded
	// or explicitly dropped for a known reason.
	const accounted = stats.yielded + stats.skippedNoCoordinate + stats.skippedMalformed

	if (accounted !== metadata.totalRows) {
		mismatches.push(
			`TOTAL: manifest ${metadata.totalRows} but yielded ${stats.yielded} + no-coordinate ${stats.skippedNoCoordinate} + malformed ${stats.skippedMalformed} = ${accounted}`
		)
	}

	if (stats.skippedMalformed > 0) {
		mismatches.push(`MALFORMED: ${stats.skippedMalformed} rows failed to parse — expected zero`)
	}

	return mismatches
}

interface DatabaseMetaInput {
	now: Date
	stats: CodePointParseStats
	metadata: CodePointMetadata
	inserted: number
	archiveMD5: string
	osVersion: string
	extracted: { licenseText: string; csvPaths: string[]; totalBytes: number }
}

/**
 * Bake the provenance record into the staging DB before vacuum and seal,
 * since a shipped DB is never patched.
 */
async function writeDatabaseMeta(db: DatabaseClient<WOFDatabase>, input: DatabaseMetaInput): Promise<void> {
	await createDatabaseMetaTable(db)

	const copyrightYear = attributionYear(input.metadata, input.now)

	const rows: Array<[string, string]> = [
		["name", "mailwoman-postalcode-gb-codepoint"],
		[
			"description",
			"GB unit postcodes from Ordnance Survey Code-Point Open as first-class WOF `postalcode` places (England, Scotland, Wales)",
		],
		["schema_version", "1"],
		["built_at", input.now.toISOString()],
		["countries", COUNTRY],
		["postcode_rows", String(input.inserted)],
		["source", "Ordnance Survey Code-Point Open — https://osdatahub.os.uk/downloads/open/CodePointOpen"],
		["source_api", "https://api.os.uk/downloads/v1/products/CodePointOpen/downloads (open, unauthenticated)"],
		["source_release", input.osVersion],
		["source_product", input.metadata.product],
		["source_dataset_version", input.metadata.datasetVersion],
		["source_copyright_date", input.metadata.copyrightDate],
		["source_royal_mail_update_date", input.metadata.royalMailUpdateDate],
		["source_archive_md5", input.archiveMD5],
		["source_manifest_rows", String(input.metadata.totalRows)],
		["license", CODEPOINT_LICENSE],
		["license_url", CODEPOINT_LICENSE_URL],
		["attribution", codePointAttribution(copyrightYear)],
		["license_text_upstream", input.extracted.licenseText.trim()],
		["coverage", CODEPOINT_COVERAGE_NOTE],
		[
			"coverage_gap_northern_ireland",
			"ZERO Northern Ireland (BT) postcodes — measured, not assumed: the source's country codes are exactly " +
				"E92000001/S92000003/W92000004 across all rows. NI postcode geography is administered by Land & Property " +
				"Services (LPS) and is not published under OGL; filling this gap requires a separate licence, not a " +
				"different build.",
		],
		["coverage_gap_northern_ireland_options", NORTHERN_IRELAND_OPTIONS_NOTE],
		[
			"method",
			"#920 laws: `name` stored in the sanitized-query token shape (every non-letter/number stripped) with the " +
				"display form as an alt `names` row. One row per unit postcode (no medoid collapse — the source is already " +
				"one row per postcode). Coordinates converted OSGB36/EPSG:27700 → WGS84 via @mailwoman/spatial's " +
				"`osgb36ToWGS84` (7-parameter Helmert; measured p50 1.74 m / p95 4.18 m / max 4.91 m against OS's 40-point " +
				"OSTN15 test set). Rows with positional-quality-indicator 90 (no coordinate available) are DROPPED.",
		],
		[
			"quality_drops",
			stringifyJSON({
				read: input.stats.read,
				yielded: input.stats.yielded,
				skippedNoCoordinate: input.stats.skippedNoCoordinate,
				skippedMalformed: input.stats.skippedMalformed,
			}),
		],
		["builder", "mailwoman gazetteer build postcode-codepoint"],
		[
			"source_files",
			stringifyJSON({ count: input.extracted.csvPaths.length, uncompressedBytes: input.extracted.totalBytes }),
		],
	]

	writeMetaRows(db, rows)
}
