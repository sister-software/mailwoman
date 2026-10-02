/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Download Suomen ympäristökeskus' Ryhti built-environment address CSV for the `ryhti` adapter.
 *
 * SYKE publishes the whole country, Åland included, as one gzipped CSV at
 * `https://paikkatiedot.ymparisto.fi/geoserver/www/open_address.csv.gz`. There is no per-region
 * distribution and no API, so the harvest is one transfer rather than a paging loop.
 *
 * The acquisition belongs under a `tools/` root. `@mailwoman/corpus` is one of the
 * `TOOLING_PACKAGES` in `dependency-cruiser.config.mjs`, which keep their tooling under `lib/`, so
 * this module sits beside `#fr/tools/fetch/ban` rather than in an `sdk/` root the workspace does
 * not declare.
 *
 * SYKE's metadata record `{DBD610F4-3392-44CD-B601-BAE8FA547A57}` grants CC BY 4.0, which the
 * address-source register elects, and states the attribution as `Lähde: Syke Ryhti`. The manifest
 * records both, and `#fi/adapters/ryhti/adapter` records the licence on every row.
 *
 * Four measured properties decide what this module does:
 *
 * 1. **The file is republished daily and its length changes with it.** `HEAD` answered
 *    `content-length: 351290196` and `last-modified: Fri, 2 Oct 2026 05:20:14 GMT` on 2026-10-02,
 *    against `351288399` and `Thu, 1 Oct 2026 05:20:03 GMT` the day before. So the re-run check is
 *    a `HEAD` compared against the manifest, which costs one small request instead of 351 MB, and
 *    neither number is written into this module as a constant.
 * 2. **The host ignores `Range`.** `bytes=0-4095` answers HTTP 200 with no `content-range` and the
 *    whole `content-length`, and `accept-ranges` is absent, so a resumed transfer is not available
 *    and an interrupted one restarts. {@linkcode resumableDownload} would refuse the response.
 * 3. **This module moves bytes and decodes none of them.** The body is streamed to disk compressed, then
 *    decompressed stream to stream, so no chunk boundary is ever interpreted as a character
 *    boundary. A `chunk.toString("utf8")` per gzip chunk produces a U+FFFD at every boundary that
 *    splits a multi-byte character, and 60,014,592 decompressed bytes of this file were scanned for
 *    `EF BF BD` with 0 found: the replacement characters such a reader reports are its own.
 * 4. **The decompressed CSV is what the adapter can read.** `#fi/adapters/ryhti/adapter` hands
 *    `opts.inputPath` to `CSVSpliterator.fromAsync`, which reads the bytes as they are on disk, so
 *    a path to the `.gz` would be parsed as CSV over gzip bytes. The `.gz` is therefore removed once the CSV is
 *    written: 793 MB of readable input instead of 351 MB plus a reader the adapter does not have.
 *    A caller that wants the compressed copy kept passes
 *    {@linkcode FetchRyhtiOptions.keepCompressed}, which costs 1.14 GB for both.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */

import { APIClient } from "@mailwoman/core/api"
import { gunzipChunks } from "@mailwoman/core/fs/compression"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { openReadStream, openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { RYHTI_ADAPTER_ID } from "#fi/adapters/ryhti/adapter"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { readManifest, streamBodyToFile, withRetries, writeManifest } from "#tools/fetch/download"

/**
 * The one file SYKE publishes for this theme.
 */
export const FI_RYHTI_CSV_URL = "https://paikkatiedot.ymparisto.fi/geoserver/www/open_address.csv.gz"

/**
 * The directory the download is written under, which is the adapter's `inputPath`'s parent.
 */
const SLUG = RYHTI_ADAPTER_ID

/**
 * The decompressed file the adapter reads.
 */
export const FI_RYHTI_CSV_FILENAME = "open_address.csv"

/**
 * The compressed file as it arrives, kept only while it is being decompressed.
 */
const COMPRESSED_FILENAME = "open_address.csv.gz"

/**
 * The licence the register elects for this file.
 */
export const FI_RYHTI_LICENSE = "CC-BY-4.0"

/**
 * The attribution SYKE states for its open data, which the model card must carry.
 */
export const FI_RYHTI_ATTRIBUTION = "Lähde: Syke Ryhti"

/**
 * The columns `#fi/adapters/ryhti/adapter` indexes by name.
 *
 * The header is checked against these rather than against a column count, because the adapter reads a
 * subset by name and a renamed column would otherwise reach it as an empty string on every row.
 * Which columns the publisher quotes is a property of the edition — the 2026-10-02
 * edition quotes `address_number`, the two number-part columns, `municipality_number`,
 * `postal_code` and `location_srid` and leaves the header and every name column bare —
 * so the check reads a quote-aware split rather than assuming either form.
 */
export const FI_RYHTI_REQUIRED_COLUMNS: readonly string[] = [
	"address_key",
	"address_name_fin",
	"address_name_swe",
	"postal_office_fin",
	"postal_office_swe",
	"municipality_number",
	"postal_code",
	"number_part_of_address_number",
	"number_part_of_address_number2",
	"subdivision_letter_of_address_number",
	"subdivision_letter_of_address_number2",
]

/**
 * What the manifest records about the one file.
 *
 * {@linkcode SourceManifest}'s five fields describe the decompressed CSV,
 * which is what the adapter reads and what the digest covers.
 * The three added fields describe the transfer, and they are what the re-run
 * check compares before it downloads 351 MB.
 */
export interface RyhtiManifest extends SourceManifest {
	license: string
	attribution: string
	/**
	 * The `Last-Modified` the host served the compressed file under, or `null` where it served none.
	 */
	last_modified: string | null
	/**
	 * The `content-length` the host stated for the compressed file, or `null` where it stated none.
	 */
	compressed_bytes: number | null
	/**
	 * The columns the header named when this file was downloaded, in order.
	 *
	 * Recorded rather than counted, so a later edition's added, removed or renamed
	 * column is a diff against this list rather than a count that moved.
	 */
	columns: readonly string[]
}

/**
 * What the host states about the file without sending it.
 */
export interface RyhtiHead {
	lastModified: string | null
	contentLength: number | null
	contentType: string | null
}

/**
 * Read what the host states about the file.
 *
 * Through `APIClient`, which is the interface for a repeated request with a small response.
 * The body itself is not taken this way: `APIClient` buffers a response, and this one is 351 MB.
 *
 * A header the host does not send is reported as `null` rather than raised on,
 * and the caller then downloads rather than treating the absence as a match.
 */
export async function readRyhtiHead(client: Pick<APIClient, "fetch">, url = FI_RYHTI_CSV_URL): Promise<RyhtiHead> {
	const response = await client.fetch<unknown>({ method: "head", url })
	const headers = response.headers as Record<string, string> | undefined
	const length = headers?.["content-length"]

	return {
		lastModified: headers?.["last-modified"] ?? null,
		contentLength: length !== undefined && /^\d+$/u.test(length) ? Number(length) : null,
		contentType: headers?.["content-type"] ?? null,
	}
}

/**
 * The header line's column names, read from the decompressed file.
 *
 * Read through `CSVSpliterator`, which is the reader the adapter uses, rather than through
 * a split of this module's own: which columns the publisher quotes is a property of the
 * edition, and a second reader would be a second answer to that question.
 * `columnScan: "rows"` keeps the first row from decoding the whole file,
 * which the default `"auto"` does even for one row.
 *
 * @throws When the file holds no row at all, so an empty or truncated file reports itself
 * rather than reading as a file with no columns.
 */
export async function readRyhtiColumns(path: PathBuilderLike): Promise<readonly string[]> {
	const [header] = await Array.fromAsync(
		CSVSpliterator.fromAsync<string[]>(path, {
			header: false,
			mode: "array",
			columnScan: "rows",
			take: 1,
		})
	)

	if (!header) {
		throw new Error(`${path.toString()}: the file holds no row, so its header could not be read`)
	}

	return header
}

/**
 * Refuse a header that does not name every column the adapter indexes.
 *
 * @throws Naming the columns that are absent, so a renamed column is a reported failure
 * rather than an empty string on every row the adapter emits.
 */
export function assertRyhtiColumns(columns: readonly string[], context: string): void {
	const present = new Set(columns)
	const absent = FI_RYHTI_REQUIRED_COLUMNS.filter((column) => !present.has(column))

	if (absent.length) {
		throw new Error(
			`${context}: the header names ${columns.length} columns and not ${absent.join(", ")}, which ` +
				`#fi/adapters/ryhti/adapter reads by name`
		)
	}
}

export interface DownloadRyhtiOptions {
	/**
	 * Where the CSV and the manifest are written.
	 * The CSV inside it is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Keep the compressed copy beside the CSV.
	 *
	 * The adapter reads the CSV, so the default removes the archive once the CSV is written.
	 * Keeping both holds 1.14 GB for the one file.
	 */
	keepCompressed?: boolean
	/**
	 * Re-read the CSV's sha256 on a re-run instead of comparing its byte count.
	 *
	 * The default compares the recorded byte count against the file's size, which is one `stat`.
	 * This re-hashes 793 MB.
	 */
	verifyDigest?: boolean
	/**
	 * Download even where the `HEAD` agrees with the manifest.
	 */
	force?: boolean
	/**
	 * Attempts after the first for the one transfer.
	 * Defaults to three.
	 *
	 * The host ignores `Range`, so each attempt starts the 351 MB again.
	 */
	retries?: number
	/**
	 * Pause between attempts, in milliseconds.
	 * Defaults to `DEFAULT_RETRY_DELAY_MS`.
	 */
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

export type FetchRyhtiOptions = BaseFetchOptions & Omit<DownloadRyhtiOptions, "outputDir" | "report">

/**
 * The directory `#fi/adapters/ryhti/adapter` reads under a fetch root.
 */
export function ryhtiInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)(FI_RYHTI_CSV_FILENAME)
}

/**
 * Whether the CSV on disk is still the one the manifest describes and the host still serves.
 *
 * The `HEAD` decides first, because the publisher rewrites the file daily
 * and states a new length and modification time when it does.
 * The file's own length is then checked, so a truncated local copy is re-fetched even
 * where the host has not changed.
 */
async function isCurrent(
	recorded: RyhtiManifest | null,
	head: RyhtiHead,
	path: PathBuilderLike,
	verifyDigest: boolean
): Promise<boolean> {
	if (!recorded) return false

	// A host that states neither cannot be compared against, so the file is downloaded.
	if (head.lastModified === null && head.contentLength === null) return false

	if (head.lastModified !== null && head.lastModified !== recorded.last_modified) return false

	if (head.contentLength !== null && head.contentLength !== recorded.compressed_bytes) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	if (!verifyDigest) return true

	return (await sha256File(path)) === recorded.sha256
}

/**
 * Download the Ryhti address CSV into `options.outputDir` and leave it beside its manifest.
 *
 * The client is injected so the re-run check is testable without the network, and so a caller
 * decides the retry policy. {@linkcode fetchRyhti} is the registry entry point and supplies one.
 *
 * Re-runnable: a run whose `HEAD` matches the manifest's recorded modification time and compressed
 * length, and whose CSV is still on disk at the recorded length, makes no request for the body.
 *
 * A full fetch is two requests, the `HEAD` and the body, and 351,290,196 compressed bytes as
 * measured on 2026-10-02, decompressing to a CSV this module measures rather than predicts.
 */
export async function downloadRyhti(
	client: Pick<APIClient, "fetch">,
	options: DownloadRyhtiOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)

	await makeDirectories(destDir)

	const csvPath = destDir(FI_RYHTI_CSV_FILENAME)
	const compressedPath = destDir(COMPRESSED_FILENAME)
	const manifestPath = destDir("MANIFEST.json")

	report?.(`=== ${SLUG}`)

	// MARK: Ask what the host holds
	//
	// One small request.
	// It is what holds a re-run to this one request when the publisher has not republished,
	// and the publisher republishes daily.

	const head = await readRyhtiHead(client, FI_RYHTI_CSV_URL)

	report?.(
		`  HEAD: ${head.contentLength === null ? "no content-length" : `${ByteFormatter.formatIEC(head.contentLength)} compressed`}` +
			`, last-modified ${head.lastModified ?? "absent"}`
	)

	const recorded = await readManifest<RyhtiManifest>(manifestPath)

	if (!options.force && (await isCurrent(recorded, head, csvPath, options.verifyDigest ?? false))) {
		report?.("  ✓ Already current (the host states the modification time and length in MANIFEST) — no download.")

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	// MARK: Transfer the compressed body
	//
	// Raw streaming rather than `APIClient`: the body is 351 MB, and `APIClient`
	// buffers a response it does not stream.
	// The host ignores `Range`, so an interrupted transfer restarts rather than resumes,
	// and `withRetries` is what bounds that.

	let compressedBytes: number

	try {
		compressedBytes = await withRetries(
			async () => {
				const response = await fetch(FI_RYHTI_CSV_URL, {
					redirect: "follow",
					signal: options.signal,
					headers: { accept: "application/gzip, application/x-gzip, */*" },
				})

				if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} — ${FI_RYHTI_CSV_URL}`)

				const contentType = response.headers.get("content-type") ?? ""

				// The host serves `application/x-gzip`.
				// An `text/html` body under http 200 is a portal page, which would otherwise
				// be written to disk and fail later as a corrupt archive.
				if (contentType.includes("text/html")) {
					throw new Error(`${FI_RYHTI_CSV_URL} answered ${contentType}, which is a page rather than the file`)
				}

				return streamBodyToFile(response, compressedPath)
			},
			{ report, label: COMPRESSED_FILENAME, retries: options.retries, retryDelayMs: options.retryDelayMs }
		)
	} catch (error) {
		report?.(`  ✗ download failed: ${error instanceof Error ? error.message : String(error)}`)
		await removePathIfPresent(compressedPath)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Downloaded ${ByteFormatter.formatIEC(compressedBytes)} (${compressedBytes} bytes) compressed`)

	// The delivered count rather than the stated one, and a disagreement is reported
	// rather than trusted in either direction: the publisher rewrites the file daily,
	// so a `HEAD` taken before the transfer can describe a different edition than the body.
	if (head.contentLength !== null && head.contentLength !== compressedBytes) {
		report?.(
			`  ! the HEAD stated ${head.contentLength} compressed bytes and ${compressedBytes} arrived, ` +
				`so the file was republished between the two requests`
		)
	}

	// MARK: Decompress, stream to stream
	//
	// No `TextDecoder` and no `toString` anywhere on this path.
	// The bytes reach the CSV as bytes, and the adapter decodes them when it parses.

	try {
		await decompressToCSV(compressedPath, csvPath)
	} catch (error) {
		report?.(`  ✗ decompress failed: ${error instanceof Error ? error.message : String(error)}`)
		await removePathIfPresent(compressedPath)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const csvStat = await tryStat(csvPath)

	if (!csvStat) {
		report?.(`  ✗ the decompressed CSV is not at ${csvPath.toString()}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	// MARK: Check the header the adapter indexes by name

	let columns: readonly string[]

	try {
		columns = await readRyhtiColumns(csvPath)
		assertRyhtiColumns(columns, `${SLUG}: ${FI_RYHTI_CSV_FILENAME}`)
	} catch (error) {
		report?.(`  ✗ ${error instanceof Error ? error.message : String(error)}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Decompressed to ${ByteFormatter.formatIEC(csvStat.size)} over ${columns.length} columns`)

	if (!options.keepCompressed) {
		await removePathIfPresent(compressedPath)

		report?.("  Removed the archive (the CSV is kept)")
	}

	// MARK: Write the manifest

	const manifest: RyhtiManifest = {
		source_url: FI_RYHTI_CSV_URL,
		downloaded_at: new Date().toISOString(),
		filename: FI_RYHTI_CSV_FILENAME,
		sha256: await sha256File(csvPath),
		bytes: csvStat.size,
		license: FI_RYHTI_LICENSE,
		attribution: FI_RYHTI_ATTRIBUTION,
		last_modified: head.lastModified,
		compressed_bytes: compressedBytes,
		columns,
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${ByteFormatter.formatIEC(manifest.bytes)}  sha256=${manifest.sha256}`)
	report?.(`  MANIFEST written to ${manifestPath.toString()}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * Download the Ryhti address CSV into `<outRoot>/ryhti/`.
 *
 * The registry entry point.
 * `#fi/adapters/ryhti/adapter` is pointed at {@linkcode ryhtiInputPath},
 * the `open_address.csv` inside that directory, rather than at the directory itself.
 */
export async function fetchRyhti(options: FetchRyhtiOptions, report?: (line: string) => void): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadRyhti(client, {
		outputDir: options.outRoot(SLUG),
		keepCompressed: options.keepCompressed,
		verifyDigest: options.verifyDigest,
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}

/**
 * Decompress one gzip file to another path, stream to stream.
 *
 * Exported because it is the step the U+FFFD report came out of, and a test exercises it
 * directly: a multi-byte character split across two gzip chunks must arrive whole.
 */
export async function decompressToCSV(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const decompressed = gunzipChunks(openReadStream(source))

	await pipeline(Readable.fromWeb(decompressed as Parameters<typeof Readable.fromWeb>[0]), openWriteStream(destination))
}
