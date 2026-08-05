/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unpack the Code-Point Open archive. `codepo_gb.zip` (14 MB) holds 121 per-postcode-area CSVs under
 *   `Data/CSV/` — `ab.csv`, `al.csv`, … `ze.csv`, one per outward-code area, 162 MB unpacked — plus a
 *   small `Doc/` tree carrying the licence text, the column headers, and a metadata file that turns out
 *   to be the most useful thing in the archive.
 *
 *   ## `Doc/metadata.txt` is a row-count manifest, and we use it as one
 *
 *   OS ships a per-area expected row count inside the archive:
 *
 *     ORDNANCE SURVEY
 *     PRODUCT: OS CODE-POINT_03.02
 *     DATASET VERSION NUMBER: 2026.2.0
 *     COPYRIGHT DATE: 20260420
 *     RM UPDATE DATE: 20260417
 *           AB      17403
 *           AL       7789
 *            B      41835
 *     …
 *
 *   That is an oracle the build gets for free: sum the manifest, compare against the rows actually
 *   parsed, and a truncated CSV or a silently-skipped area file fails loudly instead of shipping a
 *   slightly-short shard. {@link parseCodePointMetadata} reads it and {@link ExtractCodePointResult}
 *   carries it forward. Verified against the 2026-05 cut: the manifest sums to 1,747,841 and the CSVs
 *   hold exactly 1,747,841 rows.
 *
 *   Extraction is to disk rather than streamed in memory because the dated acquisition directory IS the
 *   cache — a rebuild re-reads the CSVs instead of re-downloading, and a human debugging a postcode can
 *   `grep` the same bytes the builder saw.
 */

import { createWriteStream } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { pipeline } from "node:stream/promises"

import { join } from "path-ts"
import { open as openZip } from "yauzl-promise"

/**
 * Archive-internal prefix of the per-area CSVs.
 */
const CSV_ENTRY_PREFIX = "Data/CSV/"

/**
 * Archive-internal prefix of the documentation tree (licence, column headers, metadata).
 */
const DOC_ENTRY_PREFIX = "Doc/"

/**
 * The header block of `Doc/metadata.txt`, parsed off the leading lines. Everything after these is the per-area count
 * table.
 */
export interface CodePointMetadata {
	/**
	 * `OS CODE-POINT_03.02` — the product/spec version.
	 */
	product: string
	/**
	 * `2026.2.0` — the internal dataset version. Distinct from the Downloads API's `2026-05` release label; both are
	 * recorded in the shard's provenance because they move independently.
	 */
	datasetVersion: string
	/**
	 * `20260420` — the OS copyright date, and the source of the YEAR that must appear in the attribution block.
	 */
	copyrightDate: string
	/**
	 * `20260417` — the Royal Mail data update date.
	 */
	royalMailUpdateDate: string
	/**
	 * Per-postcode-area expected row counts, keyed by the uppercase area code (`AB`, `B`, `ZE`).
	 */
	rowsByArea: Record<string, number>
	/**
	 * Sum of {@link rowsByArea} — the total row count the archive claims to contain.
	 */
	totalRows: number
}

/**
 * Parse `Doc/metadata.txt`.
 *
 * The format is positional and undocumented, so this is defensive: the four header fields are located by their `KEY:`
 * label rather than by line number, and the count table is every remaining line that looks like `<area> <integer>`. A
 * line that does not is skipped rather than fatal — OS has added header fields before (the `RM UPDATE DATE` row is
 * newer than the product), and a new one must not break the build.
 */
export function parseCodePointMetadata(text: string): CodePointMetadata {
	const field = (label: string): string => {
		const match = new RegExp(`^${label}:\\s*(.+)$`, "m").exec(text)

		return match?.[1]?.trim() ?? ""
	}

	const rowsByArea: Record<string, number> = {}

	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*([A-Z]{1,2})\s+(\d+)\s*$/.exec(line)

		if (match?.[1]) {
			rowsByArea[match[1]] = Number(match[2])
		}
	}

	return {
		product: field("PRODUCT"),
		datasetVersion: field("DATASET VERSION NUMBER"),
		copyrightDate: field("COPYRIGHT DATE"),
		royalMailUpdateDate: field("RM UPDATE DATE"),
		rowsByArea,
		totalRows: Object.values(rowsByArea).reduce((sum, n) => sum + n, 0),
	}
}

export interface ExtractCodePointOptions {
	/**
	 * The downloaded `codepo_gb.zip`.
	 */
	archivePath: string
	/**
	 * Directory the `Data/CSV` and `Doc` trees are written under — normally the same dated acquisition directory the
	 * archive sits in.
	 */
	destDir: string
	onPhase?: (phase: string, detail?: string) => void
}

export interface ExtractCodePointResult {
	/**
	 * Absolute paths of the extracted per-area CSVs, sorted by area code.
	 */
	csvPaths: string[]
	/**
	 * Directory holding the extracted `Doc/` tree.
	 */
	docDir: string
	/**
	 * The archive's own manifest — the row-count oracle. See the module docstring.
	 */
	metadata: CodePointMetadata
	/**
	 * `Doc/licence.txt` verbatim, so the shard's provenance quotes OS's own words rather than ours. Note the file is
	 * Latin-1-ish and writes `©` as a byte the archive does not declare an encoding for; it is read as UTF-8 and any
	 * undecodable byte is left as the replacement character rather than guessed at.
	 */
	licenseText: string
	totalBytes: number
}

/**
 * Extract the CSV and Doc trees from `codepo_gb.zip` into `destDir`.
 */
export async function extractCodePointOpen(options: ExtractCodePointOptions): Promise<ExtractCodePointResult> {
	const phase = options.onPhase ?? (() => {})
	const csvDir = String(join(options.destDir, "Data", "CSV"))
	const docDir = String(join(options.destDir, "Doc"))

	await mkdir(csvDir, { recursive: true })
	await mkdir(docDir, { recursive: true })

	const zip = await openZip(options.archivePath)
	const csvPaths: string[] = []
	let totalBytes = 0

	phase("extract", options.archivePath)

	try {
		for await (const entry of zip) {
			const name = entry.filename

			if (name.endsWith("/")) continue

			const isCSV = name.startsWith(CSV_ENTRY_PREFIX) && name.toLowerCase().endsWith(".csv")
			const isDoc = name.startsWith(DOC_ENTRY_PREFIX)

			if (!isCSV && !isDoc) continue

			const dest = String(join(isCSV ? csvDir : docDir, name.slice(name.lastIndexOf("/") + 1)))
			const readStream = await entry.openReadStream()

			await pipeline(readStream, createWriteStream(dest))

			totalBytes += entry.uncompressedSize

			if (isCSV) {
				csvPaths.push(dest)
			}
		}
	} finally {
		await zip.close()
	}

	csvPaths.sort()

	if (!csvPaths.length) {
		throw new Error(`extractCodePointOpen: no ${CSV_ENTRY_PREFIX}*.csv entries in ${options.archivePath}`)
	}

	phase("extract", `${csvPaths.length} area CSVs, ${(totalBytes / 1_000_000).toFixed(1)} MB`)

	const metadataPath = String(join(docDir, "metadata.txt"))
	const metadata = parseCodePointMetadata(await readFile(metadataPath, "utf8"))
	const licenseText = await readFile(String(join(docDir, "licence.txt")), "utf8").catch(() => "")

	return { csvPaths, docDir, metadata, licenseText, totalBytes }
}
