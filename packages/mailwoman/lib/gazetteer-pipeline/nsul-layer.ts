/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `nsul.db` — the GB **UPRN → unit-postcode register**: the ONS National Statistics UPRN Lookup
 *   (NSUL) joined to the WGS84 point OS Open UPRN publishes for the same UPRN. Schema + the compact
 *   postcode derivation live in `@mailwoman/resolver-wof-sqlite/nsul`; the Node reader is `NSULLookup`
 *   in the same subpath. This is the GB artifact the physical-constraint design record decided on
 *   (`docs/superpowers/specs/2026-09-03-physical-constraint-prior-design.md`, section 2): the register
 *   is open, and the `PO`-area measurement on #1975 showed no reconstruction from centroids and
 *   footprints comes close to it, so the register is stored, not inferred.
 *
 *   ## Acquisition
 *
 *   NSUL is published on the ONS Open Geography portal as an ArcGIS Hub "CSV Collection" item — a zip
 *   holding one CSV per NSUL region (eleven for Great Britain) plus the user guide and code lists.
 *   There is no download step here: the item is acquired by hand into a vintage-dated
 *   `$MAILWOMAN_DATA_ROOT/nsul/<YYYY-MM>/` directory holding the zip, its `.md5` sidecar and the
 *   portal's `item.json` record, and the builder reads provenance from those three files. A missing
 *   sidecar is recorded in words (the Code-Point discipline), never as an empty string.
 *
 *   ## Streaming
 *
 *   The eleven CSVs total 10.2 GB uncompressed; each is streamed straight out of the archive
 *   (`readZipEntry` → `TextSpliterator`) with nothing but the inflate window and one line in memory, so
 *   the build never extracts to disk and never holds a region file whole.
 *
 *   ## Coordinates come from `uprn.db`, never from the grid reference
 *
 *   Each NSUL row carries an OSGB36 grid reference (`GRIDGB1E`/`GRIDGB1N`). The build ignores it and
 *   joins the row's UPRN to `uprn.db`, copying OS's own WGS84 `lat`/`lon` and the res-9 `h3_cell`
 *   verbatim — the same reason `uprn-layer.ts` takes OS's WGS84 columns over a Helmert reprojection.
 *   A UPRN absent from `uprn.db` is counted `skipped-no-coordinate` and not written; a row whose
 *   `PCDS` is empty (a postcode not in Code-Point Open) is counted `skipped-no-postcode` and not
 *   written.
 *
 *   ## Restricting
 *
 *   The archive md5 against the sidecar; an exact header match on every region file (schema drift
 *   fails loudly); the region set exactly the eleven GB regions (a missing or extra file fails loudly);
 *   the accounting identity `read = inserted + malformed + duplicate + no-postcode + no-coordinate`
 *   with malformed and duplicate expected ZERO; and a row floor (`NSUL_MINIMUM_PLAUSIBLE_ROWS`).
 *
 *   ## Coverage
 *
 *   GB only. ONS designates the register complete for GB (every UPRN in AddressBase whose postcode is
 *   in Code-Point Open), so every res-6 cell holding rows is written `basis: designated,
 *   completeness: 1` — the same cells and basis `uprn.db` writes, so the two layers' coverage tables
 *   describe the same ground. Cells with no rows are left ABSENT: without a GB polygon the builder
 *   cannot tell empty moorland from Northern Ireland or open sea, so per the meaning-of-zero rule it
 *   claims nothing there.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readDirectory, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { listZipEntries, readZipEntry } from "@mailwoman/core/fs/zip"
import { md5File } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	readLayerManifest,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import type { NSULDatabase } from "@mailwoman/resolver-wof-sqlite/nsul"
import type { UPRNDatabase } from "@mailwoman/resolver-wof-sqlite/uprn"
import { expandShortCellInt, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { cellToParent } from "h3-js"
import { dirname, join, resolvePath, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { UNKNOWN_PROVENANCE } from "#gazetteer-pipeline/database-lifecycle"

/**
 * SPDX id for the Open Government Licence v3.0 — the `layer_manifest.license` form.
 */
export const NSUL_LICENSE = "OGL-UK-3.0"

/**
 * The OGL v3 deed.
 */
export const NSUL_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"

/**
 * Where ONS states the licence terms for its address products, and that Northern Ireland (`BT`) postcode data is
 * outside them.
 */
export const NSUL_LICENSE_INFO_URL = "https://www.ons.gov.uk/methodology/geography/licences"

/**
 * The portal the item is published on.
 */
export const NSUL_PORTAL_URL = "https://geoportal.statistics.gov.uk"

/**
 * The four attribution statements the NSUL User Guide requires of anyone redistributing an address product derived from
 * AddressBase, in the guide's wording and order. `year` is the copyright year of the data, not the build year.
 */
export function nsulAttribution(year: number): string {
	return (
		`Contains OS data © Crown copyright and database right ${year}. ` +
		`Contains Royal Mail data © Royal Mail copyright and Database right ${year}. ` +
		`Contains GeoPlace data © Local Government Information House Limited copyright and database right ${year}. ` +
		"Source: Office for National Statistics licensed under the Open Government Licence v.3.0"
	)
}

/**
 * The exact CSV header of every region file, verified against Epoch 127 (June 2026). A drifted header fails the build
 * loudly rather than silently mapping `PCDS` by position.
 */
export const NSUL_HEADER =
	"UPRN,GRIDGB1E,GRIDGB1N,PCDS,OA21CD,CTY25CD,CED25CD,LAD25CD,WD25CD,HLTH19CD,CTRY25CD,RGN25CD,PCON24CD,EER20CD," +
	"TTWA15CD,ITL25CD,NPARK16CD,LSOA21CD,MSOA21CD,WZ11CD,SICBL26CD,BUA24CD,BUASD11CD,RUC21IND,OAC21IND,LEP21CD1," +
	"LEP21CD2,PFA23CD,IMD19IND"

/**
 * Field count of {@link NSUL_HEADER} — a line splitting to anything else is malformed. The file is quote-free by
 * construction (every field is a code or a number), so a plain comma split is exact.
 */
const NSUL_COLUMN_COUNT = 29

/**
 * Column positions read from each line. Every other column is a statistical geography this layer does not carry.
 */
const UPRN_COLUMN = 0
const PCDS_COLUMN = 3

/**
 * The eleven NSUL region files that together are Great Britain: the nine English regions, Scotland and Wales. The
 * archive is refused when its `Data/` members are not exactly this set — a missing region is a truncated Britain and an
 * extra one is a product change, and neither may pass as a smaller or larger row count.
 */
export const NSUL_REGIONS = ["EE", "EM", "LN", "NE", "NW", "SC", "SE", "SW", "WA", "WM", "YH"] as const

export type NSULRegion = (typeof NSUL_REGIONS)[number]

/**
 * Row floor for {@link buildNSULLayer}'s truncation guard. Epoch 127 writes 40,833,043 rows from 41,546,385 lines (the
 * rest have no Code-Point postcode or no Open UPRN point) and the register only grows, so a full-source build under
 * this floor read a truncated archive. Fixture builds pass their own.
 */
export const NSUL_MINIMUM_PLAUSIBLE_ROWS = 35_000_000

/**
 * What GB means on this product, for the layer's meta.
 */
export const NSUL_COVERAGE_NOTE =
	"NSUL covers Great Britain only (England, Scotland, Wales — eleven regional files). Northern Ireland postcode data " +
	"is excluded from ONS's open terms and requires a separate Land & Property Services licence; the Isle of Man and " +
	"the Channel Islands are outside AddressBase. A row is present only when the UPRN's postcode is in Code-Point Open " +
	"AND OS Open UPRN publishes a coordinate for it; the two skipped counts are in nsul_meta.quality_drops."

/**
 * A unit postcode as NSUL writes it: outward code (area letters, district digit, optional sub-district), one space,
 * inward code (sector digit, two unit letters). `GIR 0AA` is the one non-geographic code Code-Point Open carries.
 */
const PCDS_SHAPE = /^(?:[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}|GIR 0AA)$/

/**
 * The archive member name of a region file: `Data/NSUL_E127_JUN_2026_SE.csv`.
 */
const REGION_ENTRY = /^Data\/NSUL_E(\d+)_([A-Z]{3})_(\d{4})_([A-Z]{2})\.csv$/

/**
 * The archive file name: `NSUL_E127_JUN_2026.zip`.
 */
const ARCHIVE_NAME = /^NSUL_E(\d+)_([A-Z]{3})_(\d{4})\.zip$/i

/**
 * The three-letter month ONS puts in the file name, to its number and its name.
 */
const MONTHS: Record<string, { number: string; name: string }> = {
	JAN: { number: "01", name: "January" },
	FEB: { number: "02", name: "February" },
	MAR: { number: "03", name: "March" },
	APR: { number: "04", name: "April" },
	MAY: { number: "05", name: "May" },
	JUN: { number: "06", name: "June" },
	JUL: { number: "07", name: "July" },
	AUG: { number: "08", name: "August" },
	SEP: { number: "09", name: "September" },
	OCT: { number: "10", name: "October" },
	NOV: { number: "11", name: "November" },
	DEC: { number: "12", name: "December" },
}

/**
 * What one NSUL data line is, for the accounting identity. Exactly one class per line, so the five counters sum to the
 * lines read.
 */
export type NSULLineClass =
	| { kind: "row"; uprn: number; pcds: string }
	| { kind: "no-postcode"; uprn: number }
	| { kind: "malformed" }

/**
 * Classify one data line of an NSUL region file.
 *
 * CRLF-terminated in the wild: the `\r` is stripped at the reader boundary or the LAST column carries it into every
 * value (the G-NAF lesson). A line is malformed when its field count is not {@link NSUL_COLUMN_COUNT}, when `UPRN` is
 * not a literal digit string within the safe-integer range, or when a non-empty `PCDS` does not have a unit-postcode
 * shape — a postcode-shaped column holding anything else is a defect to be counted, not a key to be stored.
 */
export function classifyNSULLine(line: string): NSULLineClass {
	const parts = (line.endsWith("\r") ? line.slice(0, -1) : line).split(",")

	if (parts.length !== NSUL_COLUMN_COUNT) return { kind: "malformed" }

	const uprnText = parts[UPRN_COLUMN]!

	if (!/^\d+$/.test(uprnText)) return { kind: "malformed" }

	const uprn = Number(uprnText)

	if (!Number.isSafeInteger(uprn) || uprn <= 0) return { kind: "malformed" }

	const pcds = parts[PCDS_COLUMN]!

	if (pcds === "") return { kind: "no-postcode", uprn }

	if (!PCDS_SHAPE.test(pcds)) return { kind: "malformed" }

	return { kind: "row", uprn, pcds }
}

/**
 * Strip the header line's BOM (U+FEFF, by char code so no invisible character hides in this source file) and CRLF, and
 * compare it to {@link NSUL_HEADER}. Returns the header as found when it drifts, `null` when it matches.
 */
export function nsulHeaderDrift(rawLine: string): string | null {
	const withoutBOM = rawLine.charCodeAt(0) === 0xfe_ff ? rawLine.slice(1) : rawLine
	const header = withoutBOM.endsWith("\r") ? withoutBOM.slice(0, -1) : withoutBOM

	return header === NSUL_HEADER ? null : header
}

/**
 * The vintage an NSUL archive name encodes: `NSUL_E127_JUN_2026.zip` → epoch 127, `2026-06`.
 */
export interface NSULVintage {
	epoch: number
	/**
	 * `YYYY-MM`.
	 */
	month: string
	/**
	 * The month's English name — `June`.
	 */
	monthName: string
	/**
	 * The copyright year of the data — the year in the archive name.
	 */
	year: number
}

/**
 * Parse the vintage out of an archive (or region file) name, or `null` when the name is not NSUL's.
 */
export function parseNSULVintage(name: string): NSULVintage | null {
	const match = ARCHIVE_NAME.exec(name) ?? REGION_ENTRY.exec(name)

	if (!match) return null

	const month = MONTHS[match[2]!.toUpperCase()]

	if (!month) return null

	return {
		epoch: Number(match[1]),
		month: `${match[3]}-${month.number}`,
		monthName: month.name,
		year: Number(match[3]),
	}
}

/**
 * The `layer_manifest.version` / `source_vintage` form of a vintage.
 */
export function nsulVintageLabel(vintage: NSULVintage): string {
	return `${vintage.month} (Epoch ${vintage.epoch})`
}

/**
 * One region's CSV, as a stream of lines — the interface between "which bytes" and "what they mean", so a fixture
 * supplies files on disk and the real build streams archive members through the same ingest loop.
 */
export interface NSULRegionSource {
	region: NSULRegion
	/**
	 * Where the bytes came from, for the build log and the meta table.
	 */
	label: string
	lines: () => AsyncIterable<string>
}

/**
 * The subset of the ONS portal's `item.json` this build records.
 */
interface NSULItemRecord {
	id?: string
	title?: string
	name?: string
	/**
	 * Epoch milliseconds.
	 */
	modified?: number
	size?: number
}

/**
 * Locate the archive in `sourceDir` and turn its eleven region members into streaming sources, refusing a region set
 * that is not exactly {@link NSUL_REGIONS}.
 */
export async function openNSULArchive(sourceDir: string): Promise<{
	archivePath: string
	archiveName: string
	vintage: NSULVintage
	sources: NSULRegionSource[]
}> {
	const entries = await readDirectory(sourceDir).catch(() => [] as string[])
	const archiveName = entries.find((name) => ARCHIVE_NAME.test(name))

	if (!archiveName) {
		throw new Error(`buildNSULLayer: no NSUL_E<epoch>_<MON>_<YYYY>.zip in ${sourceDir}`)
	}

	const vintage = parseNSULVintage(archiveName)

	if (!vintage) {
		throw new Error(`buildNSULLayer: cannot read a vintage out of ${archiveName}`)
	}

	const archivePath = String(join(sourceDir, archiveName))
	const members = await listZipEntries(archivePath)
	const found = new Map<string, string>()

	for (const member of members) {
		const match = REGION_ENTRY.exec(member.name)

		if (match) {
			found.set(match[4]!, member.name)
		}
	}

	const missing = NSUL_REGIONS.filter((region) => !found.has(region))
	const extra = [...found.keys()].filter((region) => !(NSUL_REGIONS as readonly string[]).includes(region))

	if (missing.length || extra.length) {
		throw new Error(
			`buildNSULLayer: ${archiveName} region set drift — missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]; ` +
				`expected exactly ${NSUL_REGIONS.join(", ")}`
		)
	}

	const sources: NSULRegionSource[] = NSUL_REGIONS.map((region) => {
		const memberName = found.get(region)!

		return {
			region,
			label: `${archiveName}!${memberName}`,
			lines: () => TextSpliterator.fromAsync(readZipEntry(archivePath, memberName)),
		}
	})

	return { archivePath, archiveName, vintage, sources }
}

/**
 * The newest vintage directory under `<data-root>/nsul/` holding an NSUL archive — the default source when the caller
 * names none. Vintage directories are `YYYY-MM`, so lexical order is chronological order.
 */
export async function resolveLatestNSULSourceDir(root = String(dataRootPath("nsul"))): Promise<string> {
	const candidates = await readDirectory(root).catch(() => [] as string[])

	for (const name of candidates
		.filter((entry) => /^\d{4}-\d{2}$/.test(entry))
		.toSorted()
		.toReversed()) {
		const dir = String(join(root, name))
		const entries = await readDirectory(dir).catch(() => [] as string[])

		if (entries.some((entry) => ARCHIVE_NAME.test(entry))) return dir
	}

	throw new Error(`buildNSULLayer: no <YYYY-MM>/NSUL_*.zip acquisition under ${root}`)
}

export interface BuildNSULLayerOptions {
	/**
	 * Acquisition directory holding the archive, its `.md5` sidecar and `item.json`. Default: the newest vintage
	 * directory under `<data-root>/nsul/` that holds an archive ({@link resolveLatestNSULSourceDir}).
	 */
	sourceDir?: PathBuilderLike
	/**
	 * Output artifact. Default `<data-root>/nsul/nsul.db`. Built to a staging path and atomically swapped into place.
	 */
	out?: string
	/**
	 * The `uprn.db` whose coordinates are joined in. Default `<data-root>/uprn/uprn.db`.
	 */
	uprnDatabasePath?: string
	/**
	 * Build clock — the `created_at` fallback. Passed in so the module never reads the clock implicitly.
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
	 * Truncation-guard floor. Default {@link NSUL_MINIMUM_PLAUSIBLE_ROWS}; fixture builds pass their own.
	 */
	minimumPlausibleRows?: number
	/**
	 * Injected region sources plus the vintage they carry — the fixture path. Skips the archive entirely; provenance
	 * still comes from `sourceDir`'s sidecars when present.
	 */
	sources?: { vintage: NSULVintage; regions: NSULRegionSource[] }
	onPhase?: (phase: string, detail?: string) => void
}

export interface BuildNSULLayerResult {
	out: string
	sourceDir: string
	/**
	 * Data lines read across every region file (headers excluded).
	 */
	read: number
	/**
	 * Rows written.
	 */
	inserted: number
	/**
	 * Lines {@link classifyNSULLine} refused — expected ZERO; any are reported in `mismatches`.
	 */
	skippedMalformed: number
	/**
	 * Lines whose UPRN collided with an already-written row — expected ZERO (UPRN is the register's own key).
	 */
	skippedDuplicate: number
	/**
	 * Lines whose `PCDS` is empty — the postcode is not in Code-Point Open. Expected non-zero; recorded, never a defect.
	 */
	skippedNoPostcode: number
	/**
	 * Lines whose UPRN `uprn.db` holds no point for. Expected small and non-zero (the two products are extracted from
	 * AddressBase at different dates); recorded, never a defect.
	 */
	skippedNoCoordinate: number
	/**
	 * Lines read per region, in {@link NSUL_REGIONS} order.
	 */
	readByRegion: Record<NSULRegion, number>
	/**
	 * Res-6 coverage cells written.
	 */
	coverageCells: number
	archiveMD5: string
	vintage: NSULVintage
	/**
	 * `layer_manifest.version` of the `uprn.db` the coordinates came from.
	 */
	uprnLayerVersion: string
	/**
	 * Every violated check, in words. Empty on a clean build; the caller decides whether to fail on them.
	 */
	mismatches: string[]
	durationMs: number
	sealed: boolean
}

/**
 * Read the `<archive>.md5` sidecar's digest, or `null` when there is none.
 */
async function readMD5Sidecar(archivePath: string): Promise<string | null> {
	const text = await readLocalTextFile(`${archivePath}.md5`).catch(() => null)
	const digest = text ? /^([0-9a-f]{32})\b/i.exec(text.trim())?.[1] : undefined

	return digest ? digest.toLowerCase() : null
}

/**
 * The `uprn.db` row the coordinate probe answers with.
 */
interface NSULCoordinateRow {
	lat: number
	lon: number
	h3_cell: number
}

/**
 * The five counters of the accounting identity plus what the ingest loop accumulates for coverage.
 */
export interface NSULIngestCounts {
	read: number
	inserted: number
	skippedMalformed: number
	skippedDuplicate: number
	skippedNoPostcode: number
	skippedNoCoordinate: number
	readByRegion: Record<NSULRegion, number>
	/**
	 * Res-6 coverage cell → rows written in it.
	 */
	coverage: Map<number, number>
}

interface IngestNSULSourcesOptions {
	sources: NSULRegionSource[]
	/**
	 * `uprn.db`'s point for a UPRN, or `undefined` when it holds none.
	 */
	coordinateOf: (uprn: number) => NSULCoordinateRow | undefined
	/**
	 * Write one row; `false` when the UPRN was already written (the `INSERT OR IGNORE` duplicate path).
	 */
	write: (line: Extract<NSULLineClass, { kind: "row" }>, point: NSULCoordinateRow) => boolean
	/**
	 * The res-6 coverage cell a row's res-9 cell rolls up to.
	 */
	parentCell: (h3Cell: number) => number
	/**
	 * Called every million rows written — the transaction boundary.
	 */
	checkpoint: () => void
	phase: (phase: string, detail?: string) => void
}

/**
 * The ingest loop: stream every region, classify every line, join the coordinate, write, and account. Throws on header
 * drift; the caller owns the transaction and rolls it back.
 */
async function ingestNSULSources(options: IngestNSULSourcesOptions): Promise<NSULIngestCounts> {
	const { sources, coordinateOf, write, parentCell, checkpoint, phase } = options
	const coverage = new Map<number, number>()
	// res-9 short cell → res-6 short cell. Rows cluster many to a res-9 cell, so the parent walk runs once per cell
	// rather than once per row.
	const parentOf = new Map<number, number>()
	const readByRegion = Object.fromEntries(NSUL_REGIONS.map((region) => [region, 0])) as Record<NSULRegion, number>
	let read = 0
	let inserted = 0
	let skippedMalformed = 0
	let skippedDuplicate = 0
	let skippedNoPostcode = 0
	let skippedNoCoordinate = 0

	for (const source of sources) {
		phase("ingest", source.label)
		let headerSeen = false

		for await (const rawLine of source.lines()) {
			if (!headerSeen) {
				const drift = nsulHeaderDrift(rawLine)

				if (drift !== null) {
					throw new Error(
						`buildNSULLayer: header drift in ${source.label} — expected ${JSON.stringify(NSUL_HEADER)}, found ${JSON.stringify(drift)}`
					)
				}

				headerSeen = true

				continue
			}

			if (!rawLine || rawLine === "\r") continue

			read++

			readByRegion[source.region]++

			const line = classifyNSULLine(rawLine)

			if (line.kind === "malformed") {
				skippedMalformed++

				continue
			}

			if (line.kind === "no-postcode") {
				skippedNoPostcode++

				continue
			}

			const point = coordinateOf(line.uprn)

			if (!point) {
				skippedNoCoordinate++

				continue
			}

			if (!write(line, point)) {
				skippedDuplicate++

				continue
			}

			inserted++

			let parent = parentOf.get(point.h3_cell)

			if (parent === undefined) {
				parent = parentCell(point.h3_cell)
				parentOf.set(point.h3_cell, parent)
			}

			coverage.set(parent, (coverage.get(parent) ?? 0) + 1)

			if (inserted % 1_000_000 === 0) {
				checkpoint()

				if (inserted % 5_000_000 === 0) {
					phase("ingest", `${inserted.toLocaleString()} rows…`)
				}
			}
		}
	}

	return {
		read,
		inserted,
		skippedMalformed,
		skippedDuplicate,
		skippedNoPostcode,
		skippedNoCoordinate,
		readByRegion,
		coverage,
	}
}

/**
 * The checks, in words. ONS publishes no row-count manifest for the collection, so they are internal consistency plus
 * the truncation floor. Empty on a clean build.
 */
export function nsulMismatches(counts: NSULIngestCounts, minimumPlausibleRows: number): string[] {
	const { read, inserted, skippedMalformed, skippedDuplicate, skippedNoPostcode, skippedNoCoordinate } = counts
	const mismatches: string[] = []

	if (inserted + skippedMalformed + skippedDuplicate + skippedNoPostcode + skippedNoCoordinate !== read) {
		mismatches.push(
			`TOTAL: read ${read} but inserted ${inserted} + malformed ${skippedMalformed} + duplicate ${skippedDuplicate} ` +
				`+ no-postcode ${skippedNoPostcode} + no-coordinate ${skippedNoCoordinate} do not account for it`
		)
	}

	if (skippedMalformed > 0) {
		mismatches.push(`MALFORMED: ${skippedMalformed} rows failed to parse — expected zero`)
	}

	if (skippedDuplicate > 0) {
		mismatches.push(`DUPLICATE: ${skippedDuplicate} repeated UPRNs — expected zero (UPRN is the register's own key)`)
	}

	if (inserted < minimumPlausibleRows) {
		mismatches.push(
			`FLOOR: ${inserted} rows is under the ${minimumPlausibleRows.toLocaleString()} floor — truncated read?`
		)
	}

	return mismatches
}

/**
 * Build the sealed `nsul.db` layer. See the module docstring for the checks and the coverage semantics.
 */
export async function buildNSULLayer(options: BuildNSULLayerOptions): Promise<BuildNSULLayerResult> {
	const phase = options.onPhase ?? (() => {})
	const started = Date.now()
	const now = options.now ?? new Date()
	const sourceDir = options.sourceDir ? resolvePath(options.sourceDir) : await resolveLatestNSULSourceDir()
	const out = options.out ?? String(dataRootPath("nsul", "nsul.db"))
	const uprnDatabasePath = options.uprnDatabasePath ?? String(dataRootPath("uprn", "uprn.db"))
	const minimumPlausibleRows = options.minimumPlausibleRows ?? NSUL_MINIMUM_PLAUSIBLE_ROWS

	// --- Acquire. The archive is verified against its sidecar; a missing sidecar is recorded in words.
	let archiveMD5 = UNKNOWN_PROVENANCE
	let archiveName = UNKNOWN_PROVENANCE
	let vintage: NSULVintage
	let sources: NSULRegionSource[]

	if (options.sources) {
		vintage = options.sources.vintage
		sources = options.sources.regions

		phase("fixture", sources.map((source) => source.label).join(", "))
	} else {
		const archive = await openNSULArchive(sourceDir)

		archiveName = archive.archiveName
		vintage = archive.vintage
		sources = archive.sources

		const expected = await readMD5Sidecar(archive.archivePath)

		phase("verify", expected ? `md5 vs sidecar ${expected}` : "NO .md5 sidecar — archive digest recorded, not verified")

		archiveMD5 = await md5File(archive.archivePath)

		if (expected && expected !== archiveMD5) {
			throw new Error(
				`buildNSULLayer: md5 mismatch for ${archiveName} — sidecar says ${expected}, archive hashes to ${archiveMD5}`
			)
		}
	}

	const itemRaw = await readLocalTextFile(String(join(sourceDir, "item.json"))).catch(() => null)
	const item = itemRaw ? tryParsingJSON<NSULItemRecord>(itemRaw) : null

	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const {
		createUPRNPostcodeTable,
		createNSULMetaTable,
		createNSULIndexes,
		compactPostcode,
		NSUL_COVERAGE_H3_RESOLUTION,
	} = await import("@mailwoman/resolver-wof-sqlite/nsul")

	const { UPRN_H3_RESOLUTION } = await import("@mailwoman/resolver-wof-sqlite/uprn")

	// --- The coordinate source. Read-only; its manifest version goes into the meta so a reader can tell which
	// Open UPRN release each coordinate is from.
	using uprnDB = new DatabaseClient<UPRNDatabase>(uprnDatabasePath, { readOnly: true })
	const uprnLayerVersion = (await readLayerManifest(uprnDB)).version
	const coordinateProbe = uprnDB.prepare("SELECT lat, lon, h3_cell FROM uprn WHERE uprn = ?")

	const ingestPath = `${out}.ingest`

	await makeDirectories(dirname(out))

	for (const stale of [ingestPath, `${ingestPath}-wal`, `${ingestPath}-shm`]) {
		if (await pathExists(stale)) {
			await removePath(stale)
		}
	}

	phase("staging", ingestPath)
	const kdb = new DatabaseClient<NSULDatabase>(ingestPath)

	kdb.exec(`
		PRAGMA page_size = 8192;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 30000;
		PRAGMA temp_store = MEMORY;
		PRAGMA cache_size = -400000;
	`)

	await createUPRNPostcodeTable(kdb)
	await createNSULMetaTable(kdb)
	await createLayerManifestTable(kdb)
	await createLayerCoverageTable(kdb)

	// Hot positional INSERT — raw prepared statement, per the AGENTS.md bulk-load carve-out. OR IGNORE so a
	// source-side duplicate UPRN is COUNTED (via `changes === 0`) rather than aborting a 40M-row load; the
	// accounting check then reports any as a defect.
	const insert = kdb.prepare(
		"INSERT OR IGNORE INTO uprn_postcode (uprn, pcds, pcds_compact, lat, lon, h3_cell) VALUES (?, ?, ?, ?, ?, ?)"
	)

	const parentCell = (h3Cell: number): number =>
		shortCellToInt(cellToParent(expandShortCellInt(h3Cell, UPRN_H3_RESOLUTION), NSUL_COVERAGE_H3_RESOLUTION) as H3Cell)

	kdb.exec("BEGIN")

	let counts: NSULIngestCounts

	try {
		counts = await ingestNSULSources({
			sources,
			coordinateOf: (uprn) => coordinateProbe.get(uprn) as NSULCoordinateRow | undefined,
			write: (line, point) =>
				Number(
					insert.run(line.uprn, line.pcds, compactPostcode(line.pcds), point.lat, point.lon, point.h3_cell).changes
				) > 0,
			parentCell,
			checkpoint: () => {
				kdb.exec("COMMIT")
				kdb.exec("BEGIN")
			},
			phase,
		})
	} catch (error) {
		kdb.exec("ROLLBACK")
		await kdb.destroy()
		throw error
	}

	const {
		coverage,
		readByRegion,
		read,
		inserted,
		skippedMalformed,
		skippedDuplicate,
		skippedNoPostcode,
		skippedNoCoordinate,
	} = counts

	kdb.exec("COMMIT")
	phase("ingest", `${inserted.toLocaleString()} UPRN→postcode rows (${read.toLocaleString()} lines read)`)

	const mismatches = nsulMismatches(counts, minimumPlausibleRows)

	phase("indexes")
	await createNSULIndexes(kdb)

	phase("coverage", `${coverage.size.toLocaleString()} res-${NSUL_COVERAGE_H3_RESOLUTION} cells`)

	// ONS designates the register complete for GB, so observed cells are `designated`/1.0 — a miss inside one is
	// evidence of absence. Unobserved cells stay ABSENT (unknown), per the meaning-of-zero rule.
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

	const attribution = nsulAttribution(vintage.year)
	const vintageLabel = nsulVintageLabel(vintage)

	phase("manifest")

	await writeLayerManifest(kdb, {
		name: "nsul-uprn-postcode-gb",
		version: vintageLabel,
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: NSUL_LICENSE,
		attribution,
		source: `ONS National Statistics UPRN Lookup (${vintage.monthName} ${vintage.year}, Epoch ${vintage.epoch}) — ${NSUL_PORTAL_URL}`,
		sourceVintage: vintageLabel,
		buildCmd: "buildNSULLayer — packages/mailwoman/lib/gazetteer-pipeline/nsul-layer.ts",
		buildSHA: options.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: UPRN_H3_RESOLUTION } },
		createdAt: options.createdAt ?? now.toISOString(),
	})

	phase("meta")

	const metaRows: Array<[string, string]> = [
		["source", `ONS National Statistics UPRN Lookup — ${NSUL_PORTAL_URL}`],
		["source_item_id", item?.id ?? UNKNOWN_PROVENANCE],
		["source_item_title", item?.title ?? UNKNOWN_PROVENANCE],
		["source_item_modified", item?.modified ? new Date(item.modified).toISOString() : UNKNOWN_PROVENANCE],
		["source_archive", archiveName],
		["source_archive_md5", archiveMD5],
		["source_epoch", String(vintage.epoch)],
		["source_vintage", vintageLabel],
		["source_regions", NSUL_REGIONS.join(",")],
		["header_as_found", NSUL_HEADER],
		["coordinate_source", `OS Open UPRN uprn.db, layer_manifest.version ${uprnLayerVersion}`],
		[
			"quality_drops",
			JSON.stringify({ read, inserted, skippedMalformed, skippedDuplicate, skippedNoPostcode, skippedNoCoordinate }),
		],
		["read_by_region", JSON.stringify(readByRegion)],
		["license", NSUL_LICENSE],
		["license_url", NSUL_LICENSE_URL],
		["license_info_url", NSUL_LICENSE_INFO_URL],
		["attribution", attribution],
		["coverage", NSUL_COVERAGE_NOTE],
		[
			"method",
			"PCDS taken verbatim from NSUL (pcds) and with its space removed (pcds_compact, Code-Point Open's spr.name form). " +
				"lat/lon/h3_cell copied from uprn.db by UPRN join — OS's WGS84 columns, never a reprojection of GRIDGB1E/N. " +
				"Rows with empty PCDS or no uprn.db point are counted in quality_drops and not written. " +
				`Coverage = res-${NSUL_COVERAGE_H3_RESOLUTION} parents of observed rows, basis designated (ONS publishes the complete GB register).`,
		],
		["builder", "buildNSULLayer — packages/mailwoman/lib/gazetteer-pipeline/nsul-layer.ts"],
	]

	for (const [key, value] of metaRows) {
		await kdb.insertInto("nsul_meta").values({ key, value }).execute()
	}

	phase("freeze")
	kdb.exec("ANALYZE")
	await kdb.destroy()

	phase("seal", out)
	await sealDatabase(ingestPath)
	await swapDatabaseIntoPlace(ingestPath, out)

	return {
		out,
		sourceDir,
		read,
		inserted,
		skippedMalformed,
		skippedDuplicate,
		skippedNoPostcode,
		skippedNoCoordinate,
		readByRegion,
		coverageCells: coverage.size,
		archiveMD5,
		vintage,
		uprnLayerVersion,
		mismatches,
		durationMs: Date.now() - started,
		sealed: true,
	}
}
