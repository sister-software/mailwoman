/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `uprn.db` — the OS **Open UPRN** spatial layer: every GB Unique Property Reference Number
 *   with the WGS84 point OS publishes for it, so mailwoman results can carry UPRN as an
 *   interoperability key beside our own `@mailwoman/address-id`. Schema + the shared cell derivation
 *   live in `@mailwoman/resolver-wof-sqlite/uprn-schema`; the Node reader is
 *   `@mailwoman/resolver-wof-sqlite/uprn-lookup`.
 *
 *   ## Acquisition
 *
 *   Open UPRN is an OS OpenData product on the same public **OS Downloads API** as Code-Point Open
 *   (two unauthenticated GETs; the listing carries OS's own md5 + byte size, which the download is
 *   verified against). The API client is shared with `postcode/codepoint/fetch.ts` — the client is
 *   product-neutral even though its module home is not; hoisting the whole fetch trio out of
 *   `postcode/codepoint/` is the follow-up when a third OS product arrives. Acquisitions land in a
 *   dated `$MAILWOMAN_DATA_ROOT/os-uprn/<YYYY-MM-DD>/` directory with an `acquisition.json` + `.md5`
 *   sidecar, so an offline rebuild recovers provenance without re-asking an API whose answer has
 *   moved on.
 *
 *   ## Coordinates: OS's WGS84 columns, never reconverted
 *
 *   The CSV carries both OSGB36 eastings/northings AND WGS84 `LATITUDE`/`LONGITUDE` per row. This
 *   build takes OS's lat/lon verbatim: re-deriving them from eastings through our 7-parameter
 *   Helmert (measured p95 4.18 m) would replace the publisher's OSTN15-grade answer with a strictly
 *   worse one.
 *
 *   ## Gating
 *
 *   Unlike Code-Point Open, the archive ships NO row-count manifest (`versions.txt` is three label
 *   lines), so there is no upstream oracle to reconcile against. What gates instead: the archive md5
 *   against OS's published digest, an exact header match (schema drift fails loudly), the accounting
 *   identity `read = inserted + malformed + duplicate` with malformed and duplicate both expected
 *   ZERO, and a row floor (the 2026-08 cut holds 41,629,393 rows; the product only grows, so a count
 *   under the floor means a truncated read, not a smaller Britain).
 *
 *   ## Coverage
 *
 *   GB only — England, Scotland, Wales (the Downloads API publishes a single `GB` area). OS
 *   designates the product complete (every UPRN in AddressBase Premium, with geometry), so every
 *   res-6 cell holding rows is written `basis: designated, completeness: 1`. Cells with no rows are
 *   left ABSENT — some are genuinely empty GB moorland, some are Northern Ireland or open sea, and
 *   without a GB polygon the builder cannot tell which, so per the meaning-of-zero rule it claims
 *   nothing. NI property identifiers are administered by Land & Property Services (Pointer) and are
 *   not in any OS OpenData product.
 */

import { tryStat, pathExists, readDirectory, readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { removePath, makeDirectories, writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { extractZipEntries, listZipEntries } from "@mailwoman/core/fs/zip"
import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { dataRootPath, md5File } from "@mailwoman/core/utils"
import { dirname } from "@mailwoman/platform/path"
import { Readable } from "@mailwoman/platform/stream"
import { pipeline } from "@mailwoman/platform/stream/promises"
import type { UPRNDatabase } from "@mailwoman/resolver-wof-sqlite/uprn-schema"
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
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"

import { createOSDownloadsClient, OS_DOWNLOADS_API_BASE } from "./postcode/codepoint/fetch.ts"

/**
 * The OS Data Hub product id for Open UPRN.
 */
export const OPEN_UPRN_PRODUCT_ID = "OpenUPRN"

/**
 * SPDX id for the Open Government Licence v3.0 — the `layer_manifest.license` form.
 */
export const OPEN_UPRN_LICENSE = "OGL-UK-3.0"

/**
 * The OGL v3 deed.
 */
export const OPEN_UPRN_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * The attribution OS requires of OS OpenData redistributors, in the wording the archive's own `licence.txt` uses.
 * `year` is the OS copyright year as stated in that licence text — not the build year; republishing a 2026 cut in 2027
 * still attributes the 2026 data.
 */
export function openUPRNAttribution(year: number): string {
	return `Contains Ordnance Survey data © Crown copyright and database right ${year}.`
}

/**
 * The exact CSV header of the product. Verified against the 2026-08 cut; a drifted header fails the build loudly rather
 * than silently mapping columns by position.
 */
export const OPEN_UPRN_HEADER = "UPRN,X_COORDINATE,Y_COORDINATE,LATITUDE,LONGITUDE"

/**
 * Field count of {@link OPEN_UPRN_HEADER} — a line splitting to anything else is malformed.
 */
const OPEN_UPRN_COLUMN_COUNT = 5

/**
 * What `GB` means on this product: England, Scotland and Wales — the Downloads API publishes a single `GB` area, and
 * the product derives from AddressBase Premium, whose scope is GB. Northern Ireland's property identifiers are
 * administered by Land & Property Services (Pointer) and appear in no OS OpenData product, so the layer's NI hole is a
 * licensing fact, not a data-quality one — the same boundary `CODEPOINT_COVERAGE_NOTE` records for postcodes.
 */
export const OPEN_UPRN_COVERAGE_NOTE =
	"OS Open UPRN covers Great Britain only (England, Scotland, Wales — the product's single Downloads-API area is GB). " +
	"Northern Ireland, the Isle of Man and the Channel Islands are NOT included; NI property identifiers are " +
	"administered by Land & Property Services (Pointer) and are outside OS OpenData."

/**
 * What the layer records when an offline rebuild cannot recover a provenance field — a sentinel STRING, because `""`
 * reads as "no release" to anyone grepping it (the meaning-of-zero rule, applied to provenance).
 */
const UPRN_UNKNOWN_PROVENANCE = "unknown (offline rebuild, no acquisition.json)"

/**
 * Row floor for {@link buildUPRNLayer}'s truncation guard. The 2026-08 cut holds 41,629,393 rows and the register only
 * grows, so a full-source build under this floor read a truncated CSV. Fixture builds pass their own floor.
 */
export const OPEN_UPRN_MINIMUM_PLAUSIBLE_ROWS = 40_000_000

/**
 * One downloadable file OS offers for the product, as the Downloads API reports it (the same wire shape Code-Point's
 * `CodePointDownload` documents — the API is product-neutral).
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
 * The product record, for the release stamp (`2026-08`) that goes into the layer's provenance.
 */
export interface OpenUPRNProduct {
	id: string
	name: string
	version: string
}

/**
 * The three label lines of the archive's `versions.txt` — no row counts, no checksums; just enough to date the cut.
 */
export interface OpenUPRNVersions {
	/**
	 * `osopenuprn`.
	 */
	productName: string
	/**
	 * `osopenuprn_202608` — the cut's file stem.
	 */
	fileName: string
	/**
	 * `03-07-2026` (DD-MM-YYYY) — when OS extracted the cut from AddressBase Premium.
	 */
	extractionDate: string
}

/**
 * Parse `versions.txt`. Label-located rather than positional, so an added line cannot shift the fields.
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

export interface OpenUPRNPoint {
	uprn: number
	latitude: number
	longitude: number
}

/**
 * Parse one data line of the Open UPRN CSV, or `null` when the line is malformed.
 *
 * The file is CRLF-terminated (the G-NAF lesson: strip the `\r` at the reader boundary, or the LAST column — here
 * `LONGITUDE` — silently carries it into every value). Quote-free by construction: every field is numeric, so a plain
 * comma split is exact, not an assumption about lucky data.
 *
 * The UPRN must be a literal digit string (≤12 digits in the wild, so always a safe integer); the WGS84 columns 4–5 are
 * taken and the OSGB36 columns 2–3 deliberately ignored (see the module docstring).
 */
export function parseOpenUPRNLine(line: string): OpenUPRNPoint | null {
	const parts = (line.endsWith("\r") ? line.slice(0, -1) : line).split(",")

	if (parts.length !== OPEN_UPRN_COLUMN_COUNT) return null

	const uprnText = parts[0]!

	if (!/^\d+$/.test(uprnText)) return null

	const uprn = Number(uprnText)

	if (!Number.isSafeInteger(uprn) || uprn <= 0) return null

	// Shape-checked as STRINGS before Number(): `Number("")` is 0, so a truncated line like `1,2,3,51.5,`
	// would otherwise sail through as longitude zero — a plausible-looking point in the wrong hemisphere.
	if (!/^-?\d+(\.\d+)?$/.test(parts[3]!) || !/^-?\d+(\.\d+)?$/.test(parts[4]!)) return null

	const latitude = Number(parts[3])
	const longitude = Number(parts[4])

	if (latitude < LATITUDE_MIN || latitude > LATITUDE_MAX) return null

	if (longitude < LONGITUDE_MIN || longitude > LONGITUDE_MAX) return null

	return { uprn, latitude, longitude }
}

export interface DownloadOpenUPRNOptions {
	/**
	 * Directory the archive lands in — a NEW dated directory per acquisition (`$MAILWOMAN_DATA_ROOT/os-uprn/<date>/`).
	 */
	destDir: string
	/**
	 * Reuse an existing archive when it already matches OS's published md5 (the default). The sidecars are (re)written
	 * either way, so an archive that arrived outside this function — a manual `curl` — becomes self-describing on the
	 * first reuse pass.
	 */
	reuseExisting?: boolean
	client?: ReturnType<typeof createOSDownloadsClient>
	onPhase?: (phase: string, detail?: string) => void
}

export interface DownloadOpenUPRNResult {
	archivePath: string
	bytes: number
	md5: string
	/**
	 * OS's release label, e.g. `2026-08`.
	 */
	version: string
	download: OpenUPRNDownload
	reused: boolean
}

/**
 * Download the Open UPRN CSV archive into `destDir`, verifying against OS's published md5.
 *
 * The two metadata GETs go through the shared, paced `APIClient`; the ~600 MB archive body is a RAW `fetch` streamed to
 * disk — the `AGENTS.md` file-transfer carve-out, same as `downloadCodePointOpen` and `osm/sdk/fetch.ts`.
 */
export async function downloadOpenUPRN(options: DownloadOpenUPRNOptions): Promise<DownloadOpenUPRNResult> {
	const { destDir, reuseExisting = true } = options
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
	const archivePath = String(join(destDir, download.fileName))

	const writeSidecars = async (md5: string, bytes: number): Promise<void> => {
		await writeLocalTextFile(`${md5}  ${download.fileName}\n`, `${archivePath}.md5`)

		await writeLocalTextFile(
			`${JSON.stringify({ product, download, bytes, md5, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
			String(join(destDir, "acquisition.json"))
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

	// Raw `fetch`: an OS Open UPRN archive, streamed to disk below rather than held in memory.
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

export interface ExtractOpenUPRNResult {
	csvPath: string
	csvBytes: number
	/**
	 * `licence.txt` verbatim — the words a redistributor is legally required to carry, decoded strictly (UTF-8, falling
	 * back to Latin-1 for the lone `©` byte the Code-Point cut shipped) so the attribution never bakes in mojibake.
	 */
	licenseText: string
	versions: OpenUPRNVersions
}

/**
 * Decode a small provenance text file whose encoding OS does not declare. Strict UTF-8 first; a failure falls back to
 * Latin-1, whose only plausible non-ASCII byte here is `0xA9` (`©`) — the Code-Point mojibake lesson.
 */
function decodeProvenanceText(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		return new TextDecoder("latin1").decode(bytes)
	}
}

/**
 * Extract the CSV + provenance texts from the Open UPRN archive into `<destDir>/extracted/`.
 *
 * The extracted CSV is reused when its on-disk size matches the zip entry's uncompressed size exactly — the dated
 * acquisition directory IS the cache, and the size check is what tells a completed extraction from one that died
 * mid-write. (Byte size, not mtime: the zip's entries carry mode 000 and a 2026 timestamp, neither of which says
 * anything about our copy's completeness.)
 */
export async function extractOpenUPRN(options: {
	archivePath: string
	destDir: string
	onPhase?: (phase: string, detail?: string) => void
}): Promise<ExtractOpenUPRNResult> {
	const phase = options.onPhase ?? (() => {})
	const extractedDir = String(join(options.destDir, "extracted"))

	await makeDirectories(extractedDir)

	let csvPath: string | null = null
	let csvBytes = 0
	const entries = await listZipEntries(options.archivePath)
	const csvEntry = entries.find((entry) => /^osopenuprn_.*\.csv$/i.test(entry.name))

	if (csvEntry) {
		csvPath = String(join(extractedDir, csvEntry.name.slice(csvEntry.name.lastIndexOf("/") + 1)))
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

	const licensePath = String(join(extractedDir, "licence.txt"))
	const versionsPath = String(join(extractedDir, "versions.txt"))

	const licenseText = await readLocalBuffer(licensePath)
		.then(decodeProvenanceText)
		.catch(() => "")

	const versionsText = await readLocalBuffer(versionsPath)
		.then(decodeProvenanceText)
		.catch(() => "")

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

export interface BuildUPRNLayerOptions {
	/**
	 * Acquisition directory holding (or to hold) the archive and its `extracted/` tree. Default
	 * `<data-root>/os-uprn/<YYYY-MM-DD>` — a NEW dated directory per acquisition.
	 */
	sourceDir?: string
	/**
	 * Output artifact. Default `<data-root>/uprn/uprn.db`. Built to a staging path and atomically swapped into place.
	 */
	out?: string
	/**
	 * Skip the network entirely and use whatever is already in `sourceDir`. Fails if no archive is there.
	 */
	offline?: boolean
	/**
	 * Build clock — the default-path datestamp and the `created_at` fallback. Passed in so the module never reads the
	 * clock implicitly (the `defaultGazetteerVersion` convention).
	 */
	now?: Date
	/**
	 * ISO-8601 `layer_manifest.created_at`. Caller-supplied per the layer contract; defaults to `now`.
	 */
	createdAt?: string
	/**
	 * Git sha of the building tree (`buildSHA(repoRoot)` from `stamp-manifest.ts`) — the builder never guesses it.
	 */
	buildSHA: string
	/**
	 * Truncation-guard floor. Default {@link OPEN_UPRN_MINIMUM_PLAUSIBLE_ROWS}; fixture builds pass their own.
	 */
	minimumPlausibleRows?: number
	/**
	 * Injected extraction result — the fixture path, the `build-poi.ts` `rows` precedent. Skips download and unzip
	 * entirely; provenance still comes from `sourceDir`'s `acquisition.json` when one is present.
	 */
	extracted?: ExtractOpenUPRNResult
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildUPRNLayerResult {
	out: string
	sourceDir: string
	/**
	 * Data lines read (header excluded).
	 */
	read: number
	/**
	 * UPRN rows written.
	 */
	inserted: number
	/**
	 * Lines that failed {@link parseOpenUPRNLine} — expected ZERO; any are reported in `mismatches`.
	 */
	skippedMalformed: number
	/**
	 * Lines whose UPRN collided with an already-written row — expected ZERO (UPRN is the source's own primary key).
	 */
	skippedDuplicate: number
	/**
	 * Res-6 coverage cells written.
	 */
	coverageCells: number
	archiveMD5: string
	/**
	 * OS's release label, e.g. `2026-08`.
	 */
	osVersion: string
	versions: OpenUPRNVersions
	/**
	 * Every violated gate, in words. Empty on a clean build; the caller decides whether to fail on them.
	 */
	mismatches: string[]
	durationMs: number
	sealed: boolean
}

/**
 * `YYYY-MM-DD` in UTC — the dated-acquisition suffix.
 */
function datestamp(now: Date): string {
	return now.toISOString().slice(0, 10)
}

/**
 * The sidecar {@link downloadOpenUPRN} writes beside the archive.
 */
interface UPRNAcquisitionSidecar {
	product?: { version?: string }
	md5?: string
}

/**
 * Locate the acquired archive in an offline `sourceDir`.
 */
async function resolveOfflineArchive(sourceDir: string): Promise<string> {
	const entries = await readDirectory(sourceDir).catch(() => [] as string[])
	const archive = entries.find((name) => /^osopenuprn_.*\.zip$/i.test(name))

	if (!archive) {
		throw new Error(`buildUPRNLayer: offline build found no osopenuprn_*.zip in ${sourceDir}`)
	}

	return String(join(sourceDir, archive))
}

/**
 * Build the sealed `uprn.db` layer. See the module docstring for the gates and the coverage semantics.
 */
export async function buildUPRNLayer(options: BuildUPRNLayerOptions): Promise<BuildUPRNLayerResult> {
	const phase = options.onPhase ?? (() => {})
	const started = Date.now()
	const now = options.now ?? new Date()
	const stamp = datestamp(now)
	const sourceDir = options.sourceDir ?? String(dataRootPath("os-uprn", stamp))
	const out = options.out ?? String(dataRootPath("uprn", "uprn.db"))
	const minimumPlausibleRows = options.minimumPlausibleRows ?? OPEN_UPRN_MINIMUM_PLAUSIBLE_ROWS

	// --- Acquire. An offline rebuild recovers provenance from the acquisition.json sidecar; when even that
	// is missing, the layer records the ABSENCE in words (the Code-Point discipline).
	let archiveMD5: string
	let osVersion: string

	const readSidecarProvenance = async (): Promise<UPRNAcquisitionSidecar | null> => {
		const raw = await readLocalTextFile(String(join(sourceDir, "acquisition.json"))).catch(() => null)

		return raw ? tryParsingJSON<UPRNAcquisitionSidecar>(raw) : null
	}

	let extracted: ExtractOpenUPRNResult

	if (options.extracted) {
		const sidecar = await readSidecarProvenance()

		archiveMD5 = sidecar?.md5 ?? UPRN_UNKNOWN_PROVENANCE
		osVersion = sidecar?.product?.version ?? UPRN_UNKNOWN_PROVENANCE
		extracted = options.extracted

		phase("fixture", extracted.csvPath)
	} else if (options.offline) {
		const archivePath = await resolveOfflineArchive(sourceDir)
		const sidecar = await readSidecarProvenance()

		archiveMD5 = sidecar?.md5 ?? UPRN_UNKNOWN_PROVENANCE
		osVersion = sidecar?.product?.version ?? UPRN_UNKNOWN_PROVENANCE

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

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { createUPRNTable, createUPRNMetaTable, createUPRNIndexes, uprnFullCell, UPRN_COVERAGE_H3_RESOLUTION } =
		await import("@mailwoman/resolver-wof-sqlite/uprn-schema")

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

	// Hot positional INSERT — raw prepared statement, per the AGENTS.md bulk-load carve-out. OR IGNORE so a
	// source-side duplicate UPRN is COUNTED (via `changes === 0`) rather than aborting a 41M-row load; the
	// accounting gate then reports any as a defect.
	const insert = kdb.prepare("INSERT OR IGNORE INTO uprn (uprn, lat, lon, h3_cell) VALUES (?, ?, ?, ?)")

	const coverage = new Map<number, number>()
	let read = 0
	let inserted = 0
	let skippedMalformed = 0
	let skippedDuplicate = 0
	let headerSeen = false

	phase("ingest", extracted.csvPath)
	kdb.exec("BEGIN")

	for await (const rawLine of TextSpliterator.fromAsync(extracted.csvPath)) {
		if (!headerSeen) {
			// The header is BOM-prefixed (U+FEFF) and CRLF-terminated in the wild; strip both before the
			// exact match. The BOM check is by char code so no invisible character hides in this source file.
			const withoutBOM = rawLine.charCodeAt(0) === 0xfe_ff ? rawLine.slice(1) : rawLine
			const header = withoutBOM.endsWith("\r") ? withoutBOM.slice(0, -1) : withoutBOM

			if (header !== OPEN_UPRN_HEADER) {
				kdb.exec("ROLLBACK")
				await kdb.destroy()
				throw new Error(
					`buildUPRNLayer: header drift — expected ${JSON.stringify(OPEN_UPRN_HEADER)}, found ${JSON.stringify(header)}`
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

	// --- Gates. No upstream row-count manifest exists for this product (see the module docstring), so the
	// checks are internal consistency plus the truncation floor.
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

	// OS designates the product complete for GB, so observed cells are `designated`/1.0 — a miss inside one
	// is evidence of absence. Unobserved cells stay ABSENT (unknown), per the meaning-of-zero rule.
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
		buildCmd: "buildUPRNLayer — packages/mailwoman/gazetteer-pipeline/uprn-layer.ts",
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
		["source_file", extracted.versions.fileName || UPRN_UNKNOWN_PROVENANCE],
		["source_extraction_date", extracted.versions.extractionDate || UPRN_UNKNOWN_PROVENANCE],
		["source_archive_md5", archiveMD5],
		["header_as_found", OPEN_UPRN_HEADER],
		["quality_drops", JSON.stringify({ read, inserted, skippedMalformed, skippedDuplicate })],
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
		["builder", "buildUPRNLayer — packages/mailwoman/gazetteer-pipeline/uprn-layer.ts"],
	]

	for (const [key, value] of metaRows) {
		await kdb.insertInto("uprn_meta").values({ key, value }).execute()
	}

	phase("freeze")
	kdb.exec("ANALYZE")
	await kdb.destroy()

	phase("seal", out)
	await sealDatabase(ingestPath)
	swapDatabaseIntoPlace(ingestPath, out)

	return {
		out,
		sourceDir,
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
