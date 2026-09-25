/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { tryStat, pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { removePath, makeDirectories, writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { extractZipEntries, listZipEntries } from "@mailwoman/core/fs/zip"
import { md5File } from "@mailwoman/core/hash"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { isoDate } from "@mailwoman/core/utils"
import { CoverageBasis } from "@mailwoman/evidence"
import { uprnDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { UPRNDatabase } from "@mailwoman/resolver-wof-sqlite/uprn"
import {
	LATITUDE_MAX,
	LATITUDE_MIN,
	LONGITUDE_MAX,
	LONGITUDE_MIN,
	shortCellToInt,
	type H3Cell,
} from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { cellToParent } from "h3-js"
import { dirname, PathBuilder, resolvePathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { readAcquisitionSidecar, UNKNOWN_PROVENANCE } from "#gazetteer-pipeline/database-lifecycle"
import { createOSDownloadsClient, OS_DOWNLOADS_API_BASE } from "#gazetteer-pipeline/postcode/codepoint/fetch"

/**
 * The OS Data Hub product ID for Open UPRN.
 */
export const OPEN_UPRN_PRODUCT_ID = "OpenUPRN"

/**
 * The SPDX ID of the Open Government Licence v3.0, as stored in `layer_manifest.license`.
 */
export const OPEN_UPRN_LICENSE = "OGL-UK-3.0"

/**
 * The URL of the OGL v3 licence text.
 */
export const OPEN_UPRN_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * Returns the attribution OS requires of OS OpenData redistributors.
 *
 * Pass the copyright year from the archive's `licence.txt` as `year`.
 */
export function openUPRNAttribution(year: number): string {
	return `Contains Ordnance Survey data © Crown copyright and database right ${year}.`
}

/**
 * The exact CSV header that {@link buildUPRNLayer} requires.
 * A changed header fails the build.
 */
export const OPEN_UPRN_HEADER = "UPRN,X_COORDINATE,Y_COORDINATE,LATITUDE,LONGITUDE"

const OPEN_UPRN_COLUMN_COUNT = 5

/**
 * The coverage statement stored in the layer's metadata.
 * Open UPRN covers Great Britain only.
 */
export const OPEN_UPRN_COVERAGE_NOTE =
	"OS Open UPRN covers Great Britain only (England, Scotland, Wales — the product's single Downloads-API area is GB). " +
	"Northern Ireland, the Isle of Man and the Channel Islands are NOT included; NI property identifiers are " +
	"administered by Land & Property Services (Pointer) and are outside OS OpenData."

/**
 * The row count below which {@link buildUPRNLayer} reports a likely truncated read.
 */
export const OPEN_UPRN_MINIMUM_PLAUSIBLE_ROWS = 40_000_000

/**
 * Describes one file that the OS Downloads API lists for the product.
 *
 * {@link downloadOpenUPRN} verifies the archive against `md5`.
 */
export interface OpenUPRNDownload {
	md5: string
	size: number
	url: string
	format: string
	area: string
	fileName: string
}

/**
 * The OS product record.
 * Its `version` is the release label, such as `2026-08`.
 */
export interface OpenUPRNProduct {
	id: string
	name: string
	version: string
}

/**
 * The labelled fields of the archive's `versions.txt`.
 */
export interface OpenUPRNVersions {
	/**
	 * The `Product Name` field, such as `osopenuprn`.
	 */
	productName: string

	/**
	 * The `File Name` field, such as `osopenuprn_202608`.
	 */
	fileName: string

	/**
	 * The `Data Extraction Date` field in `DD-MM-YYYY` form.
	 *
	 * The build falls back to its last four characters for the attribution year.
	 */
	extractionDate: string
}

/**
 * Parses `versions.txt` by label.
 * A missing field becomes an empty string.
 */
export function parseOpenUPRNVersions(text: string): OpenUPRNVersions {
	const field = (label: string): string => {
		const match = new RegExp(`^${label}:\\s*(.+)$`, "m").exec(text)

		return match?.[1]?.trim() ?? ""
	}

	return {
		productName: field("Product Name"),
		fileName: field("File Name"),
		extractionDate: field("Data Extraction Date"),
	}
}

/**
 * One parsed Open UPRN row with its WGS84 point.
 */
export interface OpenUPRNPoint {
	uprn: number
	latitude: number
	longitude: number
}

/**
 * Parses one line of the Open UPRN CSV.
 *
 * It returns `null` when the line is malformed or out of range.
 *
 * The parser uses the published WGS84 columns and ignores the OSGB36 eastings and northings.
 */
export function parseOpenUPRNLine(line: string): OpenUPRNPoint | null {
	const parts = (line.endsWith("\r") ? line.slice(0, -1) : line).split(",")

	if (parts.length !== OPEN_UPRN_COLUMN_COUNT) return null

	const uprnText = parts[0]!

	if (!/^\d+$/.test(uprnText)) return null

	const uprn = Number(uprnText)

	if (!Number.isSafeInteger(uprn) || uprn <= 0) return null

	if (!/^-?\d+(\.\d+)?$/.test(parts[3]!) || !/^-?\d+(\.\d+)?$/.test(parts[4]!)) return null

	const latitude = Number(parts[3])
	const longitude = Number(parts[4])

	if (latitude < LATITUDE_MIN || latitude > LATITUDE_MAX) return null

	if (longitude < LONGITUDE_MIN || longitude > LONGITUDE_MAX) return null

	return { uprn, latitude, longitude }
}

/**
 * Options for {@link downloadOpenUPRN}.
 */
export interface DownloadOpenUPRNOptions {
	/**
	 * The directory that receives the archive, its `.md5` sidecar and `acquisition.json`.
	 *
	 * A later download into the same directory overwrites these files.
	 */
	destDir: PathBuilderLike

	/**
	 * Whether to reuse an archive on disk that matches the published MD5.
	 * Defaults to `true`.
	 *
	 * The sidecars are rewritten on reuse as well.
	 */
	reuseExisting?: boolean
	client?: ReturnType<typeof createOSDownloadsClient>
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Describes the MD5-verified archive that {@link downloadOpenUPRN} left on disk.
 */
export interface DownloadOpenUPRNResult {
	archivePath: PathBuilder
	bytes: number
	md5: string

	/**
	 * The OS release label, such as `2026-08`.
	 */
	version: string
	download: OpenUPRNDownload
	reused: boolean
}

/**
 * Downloads the Open UPRN CSV archive into `destDir`.
 *
 * An existing copy whose MD5 matches the published digest is reused.
 * The function throws when the downloaded bytes fail the MD5 check.
 */
export async function downloadOpenUPRN(options: DownloadOpenUPRNOptions): Promise<DownloadOpenUPRNResult> {
	const { reuseExisting = true } = options
	const destDir = PathBuilder.from(options.destDir)
	const phase = options.onPhase ?? (() => {})
	const client = options.client ?? createOSDownloadsClient()

	phase("discover", `${OS_DOWNLOADS_API_BASE}/products/${OPEN_UPRN_PRODUCT_ID}`)

	const [productResponse, downloadsResponse] = await Promise.all([
		client.fetch<OpenUPRNProduct>({ url: `/products/${OPEN_UPRN_PRODUCT_ID}`, method: "GET" }),
		client.fetch<OpenUPRNDownload[]>({ url: `/products/${OPEN_UPRN_PRODUCT_ID}/downloads`, method: "GET" }),
	])

	const product = productResponse.data
	const download = downloadsResponse.data.find((d) => d.format === "CSV")

	if (!download) {
		throw new Error(
			`downloadOpenUPRN: OS Downloads API offers no CSV archive for ${OPEN_UPRN_PRODUCT_ID} ` +
				`(got: ${downloadsResponse.data.map((d) => d.format).join(", ") || "nothing"})`
		)
	}

	await makeDirectories(destDir)
	const archivePath = destDir(download.fileName)

	const writeSidecars = async (md5: string, bytes: number): Promise<void> => {
		await writeLocalTextFile(`${md5}  ${download.fileName}\n`, destDir(`${download.fileName}.md5`))

		await writeLocalTextFile(
			prettyJSON({ product, download, bytes, md5, acquiredAt: new Date().toISOString() }),
			destDir("acquisition.json")
		)
	}

	if (reuseExisting) {
		const existing = await md5File(archivePath).catch(() => null)

		if (existing === download.md5) {
			phase("reuse", `${download.fileName} already matches upstream md5`)
			await writeSidecars(existing, download.size)

			return { archivePath, bytes: download.size, md5: existing, version: product.version, download, reused: true }
		}
	}

	phase("download", `${download.fileName} (${download.size.toLocaleString()} bytes)`)

	const response = await fetch(download.url)

	if (!response.ok || !response.body) {
		throw new Error(`downloadOpenUPRN: OS download failed (${response.status}) for ${download.url}`)
	}

	let bytes = 0

	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength
			controller.enqueue(chunk)
		},
	})

	await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), openWriteStream(archivePath))

	phase("verify", `md5 vs OS-published ${download.md5}`)
	const md5 = await md5File(archivePath)

	if (md5 !== download.md5) {
		throw new Error(
			`downloadOpenUPRN: md5 mismatch for ${download.fileName} — OS published ${download.md5}, ` +
				`downloaded bytes hash to ${md5} (${bytes.toLocaleString()} of an expected ${download.size.toLocaleString()})`
		)
	}

	await writeSidecars(md5, bytes)

	return { archivePath, bytes, md5, version: product.version, download, reused: false }
}

/**
 * Describes the CSV and provenance texts that {@link extractOpenUPRN} extracted from the archive.
 */
export interface ExtractOpenUPRNResult {
	csvPath: PathBuilderLike
	csvBytes: number

	/**
	 * The full text of the archive's `licence.txt`, which a redistributor must carry.
	 *
	 * The text is decoded as strict UTF-8 with a Latin-1 fallback.
	 */
	licenseText: string
	versions: OpenUPRNVersions
}

function decodeProvenanceText(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		return new TextDecoder("latin1").decode(bytes)
	}
}

/**
 * Extracts the CSV, `licence.txt` and `versions.txt` from the Open UPRN archive into `<destDir>/extracted/`.
 *
 * Files already on disk are skipped rather than extracted again.
 */
export async function extractOpenUPRN(options: {
	archivePath: PathBuilderLike
	destDir: PathBuilderLike
	onPhase?: (phase: string, detail?: string) => void
}): Promise<ExtractOpenUPRNResult> {
	const phase = options.onPhase ?? (() => {})
	const extractedDir = resolvePathBuilder(options.destDir, "extracted")

	await makeDirectories(extractedDir)

	let csvPath: PathBuilder | null = null
	let csvBytes = 0
	const entries = await listZipEntries(options.archivePath)
	const csvEntry = entries.find((entry) => /^osopenuprn_.*\.csv$/i.test(entry.name))

	if (csvEntry) {
		csvPath = extractedDir(csvEntry.name.slice(csvEntry.name.lastIndexOf("/") + 1))
		csvBytes = csvEntry.uncompressedSize
		const existing = await tryStat(csvPath)

		phase(
			"extract",
			existing?.size === csvBytes
				? `${csvEntry.name} already extracted (${existing.size.toLocaleString()} bytes)`
				: `${csvEntry.name} (${csvBytes.toLocaleString()} bytes)`
		)
	}

	await extractZipEntries(options.archivePath, extractedDir, {
		selector: /^(?:osopenuprn_.*\.csv|licence\.txt|versions\.txt)$/i,
		flatten: true,
		skipExisting: true,
	})

	const licensePath = extractedDir("licence.txt")
	const versionsPath = extractedDir("versions.txt")

	const licenseText = decodeProvenanceText(await readLocalBuffer(licensePath))
	const versionsText = decodeProvenanceText(await readLocalBuffer(versionsPath))

	if (licenseText) {
		await writeLocalFile(licenseText, licensePath)
	}

	if (versionsText) {
		await writeLocalFile(versionsText, versionsPath)
	}

	if (!csvPath) {
		throw new Error(`extractOpenUPRN: no osopenuprn_*.csv entry in ${options.archivePath}`)
	}

	return { csvPath, csvBytes, licenseText, versions: parseOpenUPRNVersions(versionsText) }
}

/**
 * Options for {@link buildUPRNLayer}.
 */
export interface BuildUPRNLayerOptions {
	/**
	 * The acquisition directory that holds the archive and its `extracted/` tree.
	 *
	 * Defaults to `<data-root>/os-uprn/<date>`.
	 */
	sourceDir?: PathBuilderLike

	/**
	 * The output database path.
	 * Defaults to `<data-root>/db/uprn/uprn.db`.
	 *
	 * The build writes a staging file and swaps it into place.
	 */
	out?: PathBuilderLike

	/**
	 * Whether to use the archive already in `sourceDir` without network access.
	 *
	 * The build throws when that directory holds no archive.
	 */
	offline?: boolean

	/**
	 * The build clock for the default `sourceDir` date and the `createdAt` fallback.
	 */
	now?: Date

	/**
	 * The ISO-8601 timestamp for `layer_manifest.created_at`.
	 * Defaults to `now`.
	 */
	createdAt?: string

	/**
	 * The Git SHA of the building tree, recorded in the layer manifest.
	 */
	buildSHA: string

	/**
	 * The row count below which the build reports a truncation mismatch.
	 *
	 * Defaults to {@link OPEN_UPRN_MINIMUM_PLAUSIBLE_ROWS}.
	 */
	minimumPlausibleRows?: number

	/**
	 * Pre-extracted input, such as a test fixture.
	 * Setting it skips download and extraction.
	 *
	 * Provenance still comes from `acquisition.json` in `sourceDir` when that file exists.
	 */
	extracted?: ExtractOpenUPRNResult
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Summarizes a {@link buildUPRNLayer} run.
 */
export interface BuildUPRNLayerResult {
	out: string
	sourceDir: string

	/**
	 * The number of non-empty data lines read, excluding the header.
	 */
	read: number

	inserted: number

	/**
	 * The number of lines that {@link parseOpenUPRNLine} rejected.
	 * A nonzero count is reported in `mismatches`.
	 */
	skippedMalformed: number

	/**
	 * The number of lines whose UPRN was already written.
	 * A nonzero count is reported in `mismatches`.
	 */
	skippedDuplicate: number

	/**
	 * The number of H3 coverage cells written.
	 */
	coverageCells: number
	archiveMD5: string

	/**
	 * The OS release label, or the unknown-provenance marker when no acquisition record exists.
	 */
	osVersion: string
	versions: OpenUPRNVersions

	/**
	 * One message per failed row-accounting check.
	 * The caller decides whether to fail the build.
	 */
	mismatches: string[]
	durationMs: number
	sealed: boolean
}

interface UPRNAcquisitionSidecar {
	product?: { version?: string }
	md5?: string
}

async function resolveOfflineArchive(sourceDir: PathBuilder): Promise<PathBuilder> {
	const archive = await Globerator.from("*", { cwd: sourceDir, absolute: false, throwIfDirectoryMissing: false }).find(
		(name) => /^osopenuprn_.*\.zip$/i.test(name)
	)

	if (!archive) {
		throw new Error(`buildUPRNLayer: offline build found no osopenuprn_*.zip in ${sourceDir}`)
	}

	return sourceDir(archive)
}

/**
 * Builds the sealed `uprn.db` layer from OS Open UPRN.
 *
 * The build downloads the archive unless `offline` or `extracted` is set.
 * A changed header throws.
 * Row-accounting failures are returned in `mismatches`.
 */
export async function buildUPRNLayer(options: BuildUPRNLayerOptions): Promise<BuildUPRNLayerResult> {
	const phase = options.onPhase ?? (() => {})
	const started = Date.now()
	const now = options.now ?? new Date()
	const stamp = isoDate(now)
	const sourceDir = PathBuilder.from(options.sourceDir ?? dataRootPath("os-uprn", stamp))
	const out = options.out ?? uprnDatabasePath("uprn.db")
	const minimumPlausibleRows = options.minimumPlausibleRows ?? OPEN_UPRN_MINIMUM_PLAUSIBLE_ROWS

	let archiveMD5: string
	let osVersion: string

	const readSidecarProvenance = (): Promise<UPRNAcquisitionSidecar | null> =>
		readAcquisitionSidecar<UPRNAcquisitionSidecar>(sourceDir)

	let extracted: ExtractOpenUPRNResult

	if (options.extracted) {
		const sidecar = await readSidecarProvenance()

		archiveMD5 = sidecar?.md5 ?? UNKNOWN_PROVENANCE
		osVersion = sidecar?.product?.version ?? UNKNOWN_PROVENANCE
		extracted = options.extracted

		phase("fixture", extracted.csvPath.toString())
	} else if (options.offline) {
		const archivePath = await resolveOfflineArchive(sourceDir)
		const sidecar = await readSidecarProvenance()

		archiveMD5 = sidecar?.md5 ?? UNKNOWN_PROVENANCE
		osVersion = sidecar?.product?.version ?? UNKNOWN_PROVENANCE

		phase(
			"offline",
			sidecar ? `provenance from acquisition.json (${osVersion})` : "NO acquisition.json — provenance unknown"
		)

		extracted = await extractOpenUPRN({ archivePath, destDir: sourceDir, onPhase: phase })
	} else {
		const download = await downloadOpenUPRN({ destDir: sourceDir, onPhase: phase })

		archiveMD5 = download.md5
		osVersion = download.version
		extracted = await extractOpenUPRN({ archivePath: download.archivePath, destDir: sourceDir, onPhase: phase })
	}

	const { createUPRNTable, createUPRNMetaTable, createUPRNIndexes, uprnFullCell, UPRN_COVERAGE_H3_RESOLUTION } =
		await import("@mailwoman/resolver-wof-sqlite/uprn")

	const ingestPath = `${out}.ingest`

	await makeDirectories(dirname(out))

	for (const stale of [ingestPath, `${ingestPath}-wal`, `${ingestPath}-shm`]) {
		if (await pathExists(stale)) {
			await removePath(stale)
		}
	}

	phase("staging", ingestPath)
	const kdb = new DatabaseClient<UPRNDatabase>(ingestPath)

	kdb.exec(`
		PRAGMA page_size = 8192;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 30000;
		PRAGMA temp_store = MEMORY;
		PRAGMA cache_size = -400000;
	`)

	await createUPRNTable(kdb)
	await createUPRNMetaTable(kdb)
	await createLayerManifestTable(kdb)
	await createLayerCoverageTable(kdb)

	const insert = kdb.prepare("INSERT OR IGNORE INTO uprn (uprn, lat, lon, h3_cell) VALUES (?, ?, ?, ?)")

	const coverage = new Map<number, number>()
	let read = 0
	let inserted = 0
	let skippedMalformed = 0
	let skippedDuplicate = 0
	let headerSeen = false

	phase("ingest", extracted.csvPath.toString())
	kdb.exec("BEGIN")

	for await (const rawLine of TextSpliterator.fromAsync(extracted.csvPath)) {
		if (!headerSeen) {
			const header = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine

			if (header !== OPEN_UPRN_HEADER) {
				kdb.exec("ROLLBACK")
				await kdb.destroy()
				throw new Error(
					`buildUPRNLayer: header drift — expected ${stringifyJSON(OPEN_UPRN_HEADER)}, found ${stringifyJSON(header)}`
				)
			}

			headerSeen = true

			continue
		}

		if (!rawLine || rawLine === "\r") continue

		read++

		const point = parseOpenUPRNLine(rawLine)

		if (!point) {
			skippedMalformed++

			continue
		}

		const fullCell = uprnFullCell(point.latitude, point.longitude)
		const result = insert.run(point.uprn, point.latitude, point.longitude, shortCellToInt(fullCell))

		if (Number(result.changes) === 0) {
			skippedDuplicate++

			continue
		}

		inserted++

		const parent = shortCellToInt(cellToParent(fullCell, UPRN_COVERAGE_H3_RESOLUTION) as H3Cell)

		coverage.set(parent, (coverage.get(parent) ?? 0) + 1)

		if (inserted % 1_000_000 === 0) {
			kdb.exec("COMMIT")
			kdb.exec("BEGIN")

			if (inserted % 5_000_000 === 0) {
				phase("ingest", `${inserted.toLocaleString()} rows…`)
			}
		}
	}

	kdb.exec("COMMIT")
	phase("ingest", `${inserted.toLocaleString()} UPRNs (${read.toLocaleString()} lines read)`)

	const mismatches: string[] = []

	if (inserted + skippedMalformed + skippedDuplicate !== read) {
		mismatches.push(
			`TOTAL: read ${read} but inserted ${inserted} + malformed ${skippedMalformed} + duplicate ${skippedDuplicate} do not account for it`
		)
	}

	if (skippedMalformed > 0) {
		mismatches.push(`MALFORMED: ${skippedMalformed} rows failed to parse — expected zero`)
	}

	if (skippedDuplicate > 0) {
		mismatches.push(`DUPLICATE: ${skippedDuplicate} repeated UPRNs — expected zero (UPRN is the source's own PK)`)
	}

	if (inserted < minimumPlausibleRows) {
		mismatches.push(
			`FLOOR: ${inserted} rows is under the ${minimumPlausibleRows.toLocaleString()} floor — truncated read?`
		)
	}

	phase("indexes")
	await createUPRNIndexes(kdb)

	phase("coverage", `${coverage.size.toLocaleString()} res-${UPRN_COVERAGE_H3_RESOLUTION} cells`)

	await writeLayerCoverage(
		kdb,
		[...coverage.entries()]
			.toSorted((a, b) => a[0] - b[0])
			.map(([h3Cell, observedRows]) => ({
				h3Cell,
				completeness: 1,
				basis: CoverageBasis.Designated,
				observedRows,
			}))
	)

	const copyrightYear =
		Number(/database right (\d{4})/.exec(extracted.licenseText)?.[1]) ||
		Number(extracted.versions.extractionDate.slice(-4)) ||
		now.getUTCFullYear()

	phase("manifest")

	await writeLayerManifest(kdb, {
		name: "os-open-uprn",
		version: osVersion,
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: OPEN_UPRN_LICENSE,
		attribution: openUPRNAttribution(copyrightYear),
		source: `Ordnance Survey OS Open UPRN — ${OS_DOWNLOADS_API_BASE}/products/${OPEN_UPRN_PRODUCT_ID}`,
		sourceVintage: `${osVersion} (extracted ${extracted.versions.extractionDate})`,
		buildCmd: "buildUPRNLayer — packages/mailwoman/lib/gazetteer-pipeline/uprn-layer.ts",
		buildSHA: options.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: options.createdAt ?? now.toISOString(),
	})

	phase("meta")

	const metaRows: Array<[string, string]> = [
		["source", "Ordnance Survey OS Open UPRN — https://osdatahub.os.uk/downloads/open/OpenUPRN"],
		["source_api", `${OS_DOWNLOADS_API_BASE}/products/${OPEN_UPRN_PRODUCT_ID}/downloads (open, unauthenticated)`],
		["source_release", osVersion],
		["source_file", extracted.versions.fileName || UNKNOWN_PROVENANCE],
		["source_extraction_date", extracted.versions.extractionDate || UNKNOWN_PROVENANCE],
		["source_archive_md5", archiveMD5],
		["header_as_found", OPEN_UPRN_HEADER],
		["quality_drops", stringifyJSON({ read, inserted, skippedMalformed, skippedDuplicate })],
		["license", OPEN_UPRN_LICENSE],
		["license_url", OPEN_UPRN_LICENSE_URL],
		["license_text_upstream", extracted.licenseText.trim()],
		["attribution", openUPRNAttribution(copyrightYear)],
		["coverage", OPEN_UPRN_COVERAGE_NOTE],
		[
			"method",
			"WGS84 LATITUDE/LONGITUDE taken verbatim from the source (never reconverted from the OSGB36 columns). " +
				"h3_cell = res-9 short cell via @mailwoman/resolver-wof-sqlite/uprn-schema's uprnFullCell. " +
				"Coverage = res-6 parents of observed rows, basis designated (OS publishes the complete GB UPRN set).",
		],
		["builder", "buildUPRNLayer — packages/mailwoman/lib/gazetteer-pipeline/uprn-layer.ts"],
	]

	for (const [key, value] of metaRows) {
		await kdb.insertInto("uprn_meta").values({ key, value }).execute()
	}

	phase("freeze")
	kdb.exec("ANALYZE")
	await kdb.destroy()

	phase("seal", out.toString())
	await sealDatabase(ingestPath)
	await swapDatabaseIntoPlace(ingestPath, out)

	return {
		out: out.toString(),
		sourceDir: sourceDir.toString(),
		read,
		inserted,
		skippedMalformed,
		skippedDuplicate,
		coverageCells: coverage.size,
		archiveMD5,
		osVersion,
		versions: extracted.versions,
		mismatches,
		durationMs: Date.now() - started,
		sealed: true,
	}
}
