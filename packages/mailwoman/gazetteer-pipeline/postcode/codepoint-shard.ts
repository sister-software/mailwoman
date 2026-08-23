/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `postalcode-gb-codepoint-<date>.db` — the GB unit-postcode shard from Ordnance Survey
 *   **Code-Point Open**, and the licensed replacement for the 1,839,678 GeoNames `GB_full` rows
 *   currently riding inside `postalcode-geonames-tail.db`.
 *
 *   ## Why a separate builder rather than a source mode on `geonames-tail.ts`
 *
 *   Folding this in was considered and rejected on the code, not on taste. `geonames-tail.ts` is a
 *   REPRODUCER: its docstring pins it to a frozen 946 MB artifact, its country order is load-bearing
 *   because `ingestGeonamesPostal` allocates ids from one counter so a rebuild stays id-comparable,
 *   and it is gated on per-country row-count parity against that artifact. Code-Point Open shares none
 *   of its inputs — different coordinate system (OSGB36 eastings/northings, not degrees), different row
 *   grain (one row per unit postcode, so no medoid collapse), different licence block, and a row count
 *   that is SUPPOSED to differ from the frozen GB figure. Adding it as a mode would put a source that
 *   must change the numbers inside the one file whose job is to keep them identical.
 *
 *   What IS shared is shared: the unified schema, `normalizePostcodeName` (the #920 name law),
 *   `populateAncestors`, `buildFTS`, `sealDatabase`. Only the read side is new.
 *
 *   ## The #920 name law still governs
 *
 *   `spr.name` is the SANITIZED form — every non-letter/number stripped, so `SW1A 1AA` is stored as
 *   `SW1A1AA` — because that is what `sanitizeFTSQuery` reduces a parsed postcode token to at lookup
 *   time. The display form `SW1A 1AA` rides along as an extra `names` row. Storing the spaced form as
 *   the primary name is the mistake that measured WORSE than no coverage at all on CZ (#920); it is
 *   not a cosmetic choice.
 *
 *   ## Coverage
 *
 *   England, Scotland and Wales. NOT Northern Ireland — see `CODEPOINT_COVERAGE_NOTE`. The `BT` hole is
 *   permanent for this source and is recorded in the artifact's `meta` so a consumer reads it at open.
 *
 *   ## Licence
 *
 *   OGL v3 with a mandatory three-line attribution block naming OS, Royal Mail AND National Statistics.
 *   Baked into `meta` verbatim, alongside the source md5 and OS's own `Doc/licence.txt`.
 */

import { existsSync, unlinkSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"

import { tryParsingJSON } from "@mailwoman/core/objects"
import { dataRootPath, sealDatabase } from "@mailwoman/core/utils"
import { join } from "path-ts"

import { buildFTS } from "../fts.ts"
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
} from "./codepoint/index.ts"
import { createShardMetaTable } from "./geonames-tail.ts"

/**
 * Synthetic id base for Code-Point Open rows — its own namespace above GeoNames-postal (9.5e12) and NL PC6 (9.6e12), so
 * all sources coexist collision-free if a combined DB ever attaches them together.
 */
export const CODEPOINT_ID_BASE = 9_700_000_000_000

/**
 * ISO-3166-1 alpha-2 stamped on every row. Code-Point Open is a GB-only product; the ONS country code distinguishing
 * England/Scotland/Wales is carried separately on the parsed record and is not what `spr.country` means.
 */
const COUNTRY = "GB"

export interface BuildPostcodeCodePointOptions {
	/**
	 * Acquisition directory holding (or to hold) `codepo_gb.zip` and its extracted `Data/CSV` tree. Default
	 * `<data-root>/codepoint/<YYYY-MM-DD>` — a NEW dated directory per acquisition.
	 */
	sourceDir?: string
	/**
	 * Output artifact. Default `<data-root>/wof/postalcode-gb-codepoint-<YYYY-MM-DD>.db` — a NEW dated path every build.
	 * Promoting it into `DEFAULT_POSTCODE_SHARDS` is a deliberate, separate swap.
	 */
	out?: string
	/**
	 * Skip the network entirely and use whatever is already in `sourceDir`. Fails if the CSVs are not there.
	 */
	offline?: boolean
	/**
	 * Build clock — stamped into `meta.built_at` and the default paths. Passed in so the module never reads the clock
	 * implicitly (the `defaultGazetteerVersion` convention).
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
	 * Rows read and dropped, with the reason. See {@link CodePointParseStats}.
	 */
	stats: CodePointParseStats
	/**
	 * The archive's own manifest — the row-count oracle this build is gated on.
	 */
	metadata: CodePointMetadata
	/**
	 * Areas whose parsed count differs from the manifest, as `AREA: manifest→parsed`. Empty when every area agrees after
	 * accounting for the no-coordinate drops.
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
 * `YYYY-MM-DD` in UTC — the dated-artifact suffix.
 */
function datestamp(now: Date): string {
	return now.toISOString().slice(0, 10)
}

/**
 * What the shard records when an offline rebuild cannot recover a provenance field. A sentinel STRING rather than an
 * empty one: a consumer reading `source_release: ""` cannot tell "no release label exists" from "nobody looked", and
 * the meaning-of-zero rule says those are different claims.
 */
const UNKNOWN_PROVENANCE = "unknown (offline rebuild, no acquisition.json)"

/**
 * The sidecar {@link downloadCodePointOpen} writes beside the archive.
 */
interface AcquisitionSidecar {
	product?: { version?: string }
	md5?: string
}

/**
 * Recover acquisition provenance from `acquisition.json`. Absent is not fatal — the caller substitutes
 * {@link UNKNOWN_PROVENANCE} and says so in the shard.
 */
async function readAcquisitionSidecar(sourceDir: string): Promise<AcquisitionSidecar | null> {
	const raw = await readFile(String(join(sourceDir, "acquisition.json")), "utf8").catch(() => null)

	return raw ? tryParsingJSON<AcquisitionSidecar>(raw) : null
}

/**
 * Build the sealed GB Code-Point Open postcode shard.
 */
export async function buildPostcodeCodePoint(
	options: BuildPostcodeCodePointOptions = {}
): Promise<BuildPostcodeCodePointResult> {
	const phase = options.onPhase ?? (() => {})
	const now = options.now ?? new Date()
	const stamp = datestamp(now)
	const sourceDir = options.sourceDir ?? String(dataRootPath("codepoint", stamp))
	const out = options.out ?? String(dataRootPath("wof", `postalcode-gb-codepoint-${stamp}.db`))

	// --- Acquire.
	//
	// An OFFLINE build must not silently produce an artifact with blank provenance. `downloadCodePointOpen`
	// leaves an `acquisition.json` sidecar next to the archive precisely so a later offline rebuild can
	// recover the release label and md5 it would otherwise have to invent; when even that is missing, the
	// meta records the ABSENCE in words rather than an empty string, because "" reads as "no release" to
	// anyone grepping it.
	let archiveMD5: string
	let osVersion: string

	if (options.offline) {
		const sidecar = await readAcquisitionSidecar(sourceDir)

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

	const archivePath = String(join(sourceDir, "codepo_gb.zip"))
	const extracted = await extractCodePointOpen({ archivePath, destDir: sourceDir, onPhase: phase })

	phase(
		"manifest",
		`${extracted.metadata.totalRows.toLocaleString()} rows claimed across ${extracted.csvPaths.length} areas`
	)

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { createUnifiedSchema, createUnifiedIndexes, populateAncestors } =
		await import("@mailwoman/resolver-wof-sqlite/unified-schema")

	const { normalizePostcodeName } = await import("@mailwoman/resolver-wof-sqlite/geonames-postal")

	const ingestPath = `${out}.ingest`

	for (const stale of [ingestPath, `${ingestPath}-wal`, `${ingestPath}-shm`]) {
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

	// Hot positional INSERTs — raw prepared statements, per the AGENTS.md bulk-load carve-out.
	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, -1, ?, 'postalcode', '${COUNTRY}', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
	)

	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'postalcode', '${COUNTRY}', '', 0)`
	)

	const stats = createCodePointParseStats()
	let inserted = 0

	phase("ingest", `${extracted.csvPaths.length} area CSVs`)
	db.exec("BEGIN")

	for (const csvPath of extracted.csvPaths) {
		for await (const record of readCodePointCSV(csvPath, stats)) {
			// The #920 name law: sanitized form is the NAME, display form is an alt.
			const name = normalizePostcodeName(record.postcode)
			const id = CODEPOINT_ID_BASE + inserted

			// Degenerate bbox — a unit postcode is a point in this product, not a polygon.
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

	// --- Gate on the archive's own manifest. See `codepoint/extract.ts` for why this oracle exists.
	const manifestMismatches = compareAgainstManifest(extracted.metadata, stats)

	// Every row's parent_id is -1 (Code-Point carries no hierarchy), so this writes the SELF row per place
	// and nothing else. Not decorative: the resolver's parent-constraint scopes a lookup with
	// `spr.id IN (SELECT id FROM ancestors WHERE ancestor_id = ?)`, and a place absent from `ancestors`
	// can never satisfy it.
	phase("ancestors")
	const ancestorRows = populateAncestors(db)

	phase("indexes")
	await createUnifiedIndexes(db)

	phase("meta")
	await writeShardMeta(db, { now, stats, metadata: extracted.metadata, inserted, archiveMD5, osVersion, extracted })

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

	for (const sidecar of [ingestPath, `${ingestPath}-wal`, `${ingestPath}-shm`]) {
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
		sourceDir,
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
 * Compare per-area parsed counts against the archive's `Doc/metadata.txt` manifest.
 *
 * The manifest counts ROWS IN THE FILE, which includes the positional-quality-90 rows we deliberately drop, so the
 * identity being checked is `manifest[area] === parsed[area] + noCoordinateDrops[area]`.
 *
 * THE TOLERANCE MUST NOT INCLUDE MALFORMED ROWS, and the first version of this function got that wrong in a way worth
 * recording: it set `tolerance = skippedNoCoordinate + skippedMalformed`, so when a CSV-parsing bug rejected all
 * 1,746,976 coordinate-bearing rows, the tolerance grew to 1.75 M and every area "reconciled" against a shard holding
 * ZERO postcodes. A gate whose slack is derived from the size of the failure it is meant to catch cannot catch it. The
 * tolerance is now the no-coordinate drops ALONE — a deliberate, bounded, understood exclusion — and any malformed row
 * at all is reported separately as a defect by {@link buildPostcodeCodePoint}'s caller.
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

	// The national identity, which no per-area check implies: every manifest row is either yielded or
	// explicitly dropped for a known reason. This is the assertion that would have failed loudly above.
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

interface ShardMetaInput {
	now: Date
	stats: CodePointParseStats
	metadata: CodePointMetadata
	inserted: number
	archiveMD5: string
	osVersion: string
	extracted: { licenseText: string; csvPaths: string[]; totalBytes: number }
}

/**
 * Bake the provenance record into the staging DB (pre-VACUUM, pre-seal — a shipped DB is never patched).
 *
 * The attribution year comes from OS's own `COPYRIGHT DATE`, not from the build clock: republishing a 2026 cut in 2027
 * still attributes the 2026 data. Both dates are stored so the distinction stays visible.
 */
async function writeShardMeta(db: DatabaseSync, input: ShardMetaInput): Promise<void> {
	await createShardMetaTable(db)

	const copyrightYear = Number(input.metadata.copyrightDate.slice(0, 4)) || input.now.getUTCFullYear()

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
			JSON.stringify({
				read: input.stats.read,
				yielded: input.stats.yielded,
				skippedNoCoordinate: input.stats.skippedNoCoordinate,
				skippedMalformed: input.stats.skippedMalformed,
			}),
		],
		["builder", "mailwoman gazetteer build postcode-codepoint"],
		[
			"source_files",
			JSON.stringify({ count: input.extracted.csvPaths.length, uncompressedBytes: input.extracted.totalBytes }),
		],
	]

	const insert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")

	for (const [key, value] of rows) {
		insert.run(key, value)
	}
}
