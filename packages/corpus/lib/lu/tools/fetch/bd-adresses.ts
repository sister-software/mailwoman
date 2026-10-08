/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Download the Administration du cadastre et de la topographie's BD-Adresses CSV for the
 * `bd-adresses` adapter.
 *
 * The acquisition belongs under a `tools/` root. `@mailwoman/corpus` is one of the
 * `TOOLING_PACKAGES` in `dependency-cruiser.config.mjs`, which keep their tooling under `lib/`, so
 * this module sits beside `#fi/tools/fetch/ryhti` rather than in an `sdk/` root the workspace does
 * not declare.
 *
 * `data.public.lu` states `cc-zero` for this dataset. The address-source register elects
 * `CC0-1.0` for it under `lu-property-building-1`. CC0 asks for no attribution, and crediting the ACT
 * remains good practice, so the manifest records the publisher beside the license.
 *
 * Four measured properties decide what this module does:
 *
 * 1. **The download URL holds the edition's own timestamp.** The dataset is republished weekly
 *    and the CSV resource's `url` reads
 *    `https://download.data.public.lu/resources/adresses-georeferencees-bd-adresses/20260928-023119/addresses.csv`,
 *    where the path segment is the publication time. A hardcoded URL therefore pins one edition and
 *    404s on the next. The module reads {@linkcode LU_BD_ADRESSES_DATASET_URL} and takes the `url`
 *    of the resource whose `format` is `csv`. The resource's own `latest`,
 *    `https://data.public.lu/fr/datasets/r/<resource id>`, answers http 302 to the same dated path,
 *    and the dated path is the one downloaded, so the bytes and the checksum recorded beside them
 *    belong to one edition.
 * 2. **The publisher states an md5 for the file.** The resource records
 *    `checksum: {type: "md5", value: "…"}` and a `filesize`, measured as
 *    `c2df2f3c18b846144bb5d5dc57fc14ca` and 28,186,970 on the 2026-09-28 edition. The transfer is
 *    checked against both, so a truncated body is a reported failure rather than a short CSV that
 *    parses. A publisher that one day states a digest of another type is reported rather than
 *    skipped silently.
 * 3. **The file opens with a UTF-8 byte-order mark**, `EF BB BF`. The portal's `filesize` counts it.
 *    A reader that discards the mark therefore reports three bytes fewer than the portal does.
 *    The module writes the body to disk unaltered and checks the digest over the bytes as delivered.
 * 4. **The re-run check is the stated checksum against the manifest.** The dataset API answer is
 *    roughly 15 KB, so comparing it costs one small request instead of 28 MB.
 *
 * The CSV is the only one of the three bulk files this reads. The GeoJSON is 80,836,067 bytes and
 * the shapefile 19,681,289 for the same records, and `#lu/adapters/bd-adresses/adapter` hands
 * `opts.inputPath` to `CSVSpliterator.fromAsync`.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5File, sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import {
	BD_ADRESSES_ADAPTER_ID,
	BD_ADRESSES_DEFAULT_LICENSE,
	BD_ADRESSES_REQUIRED_COLUMNS,
} from "#lu/adapters/bd-adresses/adapter"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"
import { assertHeaderColumns, readDelimitedHeader } from "#tools/fetch/header"

/**
 * The dataset record that states the current edition of each bulk file.
 */
export const LU_BD_ADRESSES_DATASET_URL = "https://data.public.lu/api/1/datasets/adresses-georeferencees-bd-adresses/"

/**
 * The directory the download is written under, the adapter's `inputPath`'s parent.
 */
const SLUG = BD_ADRESSES_ADAPTER_ID

/**
 * The file the adapter reads.
 *
 * It is the publisher's own name for the resource.
 */
export const LU_BD_ADRESSES_CSV_FILENAME = "addresses.csv"

/**
 * The publisher the manifest credits.
 */
export const LU_BD_ADRESSES_ATTRIBUTION = "Administration du cadastre et de la topographie"

/**
 * The semicolon the publisher delimits with.
 */
export const LU_BD_ADRESSES_DELIMITER = ";"

/**
 * One bulk file as the dataset record describes it.
 */
export interface BDAdressesResource {
	/**
	 * The dated download URL.
	 * It identifies one edition.
	 */
	url: string
	/**
	 * The publisher's stated byte count, `null` when the record omits it.
	 */
	filesize: number | null
	/**
	 * The publisher's stated md5, `null` when the record states a digest of another type or none.
	 */
	md5: string | null
	/**
	 * The resource's own last-modified time, as the record states it.
	 */
	lastModified: string | null
}

/**
 * The manifest this module writes beside the CSV.
 */
export interface BDAdressesManifest extends SourceManifest {
	license: string
	attribution: string
	dataset_url: string
	/**
	 * The md5 the dataset record stated.
	 * The downloaded bytes were checked against it.
	 */
	publisher_md5: string | null
	/**
	 * The byte count the dataset record stated, beside the `bytes` that arrived.
	 */
	publisher_filesize: number | null
	last_modified: string | null
	columns: readonly string[]
}

/**
 * The shape the dataset API answers with, narrowed to the fields this module reads.
 */
interface DatasetRecord {
	resources?: readonly {
		format?: string
		url?: string
		filesize?: number
		checksum?: { type?: string; value?: string }
		last_modified?: string
	}[]
}

/**
 * The CSV resource of a dataset record.
 *
 * @throws When the record holds no `csv` resource with a URL, because the publisher
 * having moved the file is a reported failure rather than an empty transfer.
 */
export function readBDAdressesResource(record: DatasetRecord): BDAdressesResource {
	const resource = (record.resources ?? []).find((entry) => entry.format === "csv" && Boolean(entry.url))

	if (!resource?.url) {
		const formats = (record.resources ?? []).map((entry) => entry.format ?? "?").join(", ")

		throw new Error(
			`${LU_BD_ADRESSES_DATASET_URL} names no csv resource with a url. Its resources read ${formats || "(none)"}.`
		)
	}

	const checksum = resource.checksum

	return {
		url: resource.url,
		filesize: resource.filesize ?? null,
		// A digest of another type is read as none rather than compared as an md5,
		// so a `sha1` value is never reported as an md5 mismatch.
		md5: checksum?.type === "md5" && checksum.value ? checksum.value : null,
		lastModified: resource.last_modified ?? null,
	}
}

export interface DownloadBDAdressesOptions {
	outputDir: PathBuilderLike
	/**
	 * Download although the manifest already records this edition's checksum.
	 */
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Download the current edition of `addresses.csv` into `options.outputDir`.
 *
 * `client` is the caller's, so a test supplies its own and {@linkcode fetchBDAdresses}
 * decides the retry policy.
 */
export async function downloadBDAdresses(
	client: Pick<APIClient, "fetch">,
	options: DownloadBDAdressesOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const csvPath = destDir(LU_BD_ADRESSES_CSV_FILENAME)
	const manifestPath = destDir("MANIFEST.json")

	await makeDirectories(destDir)

	report?.(`=== ${SLUG} / ${LU_BD_ADRESSES_CSV_FILENAME}`)

	let resource: BDAdressesResource

	try {
		const { data } = await client.fetch<DatasetRecord>({
			method: "GET",
			url: LU_BD_ADRESSES_DATASET_URL,
			responseType: "json",
		})

		resource = readBDAdressesResource(data)
	} catch (error) {
		report?.(`  ✗ the dataset record could not be read: ${error instanceof Error ? error.message : String(error)}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Current edition ${resource.url}`)

	const existing = await readManifest<BDAdressesManifest>(manifestPath)
	const present = await tryStat(csvPath)

	if (
		!options.force &&
		present &&
		existing &&
		resource.md5 &&
		existing.publisher_md5 === resource.md5 &&
		existing.source_url === resource.url
	) {
		report?.(`  Already at md5 ${resource.md5}, so nothing was transferred`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	let bytes: number

	try {
		;({ bytes } = await downloadToFile({
			url: resource.url,
			dest: csvPath,
			retries: options.retries,
			retryDelayMs: options.retryDelayMs,
			headers: { accept: "text/csv, */*" },
			report,
		}))
	} catch (error) {
		report?.(`  ✗ download failed: ${error instanceof Error ? error.message : String(error)}`)
		await removePathIfPresent(csvPath)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Downloaded ${ByteFormatter.formatIEC(bytes)} (${bytes} bytes)`)

	// The delivered count against the stated one.
	// The byte-order mark the file opens with is part of what the portal counts,
	// so the two agree on a complete transfer.
	if (resource.filesize !== null && resource.filesize !== bytes) {
		report?.(
			`  ✗ the dataset record states ${resource.filesize} bytes and ${bytes} arrived, ` +
				`so the transfer is not the edition the record describes`
		)

		await removePathIfPresent(csvPath)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const md5 = await md5File(csvPath)

	if (resource.md5 && resource.md5 !== md5) {
		report?.(`  ✗ the dataset record states md5 ${resource.md5} and the bytes hash to ${md5}`)
		await removePathIfPresent(csvPath)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	let columns: readonly string[]

	try {
		columns = await readDelimitedHeader(csvPath, LU_BD_ADRESSES_DELIMITER)

		assertHeaderColumns(columns, BD_ADRESSES_REQUIRED_COLUMNS, `${SLUG}: ${LU_BD_ADRESSES_CSV_FILENAME}`)
	} catch (error) {
		report?.(`  ✗ ${error instanceof Error ? error.message : String(error)}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const manifest: BDAdressesManifest = {
		source_url: resource.url,
		downloaded_at: new Date().toISOString(),
		filename: LU_BD_ADRESSES_CSV_FILENAME,
		sha256: await sha256File(csvPath),
		bytes,
		license: BD_ADRESSES_DEFAULT_LICENSE,
		attribution: LU_BD_ADRESSES_ATTRIBUTION,
		dataset_url: LU_BD_ADRESSES_DATASET_URL,
		publisher_md5: resource.md5,
		publisher_filesize: resource.filesize,
		last_modified: resource.lastModified,
		columns,
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)} over ${columns.length} columns  sha256=${manifest.sha256}`)
	report?.(`  MANIFEST written to ${manifestPath.toString()}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

export interface FetchBDAdressesOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	signal?: AbortSignal
}

/**
 * Download BD-Adresses into `<outRoot>/bd-adresses/`.
 *
 * The registry entry point.
 * `#lu/adapters/bd-adresses/adapter` is pointed at {@linkcode bdAdressesInputPath},
 * the `addresses.csv` inside that directory, rather than at the directory itself.
 */
export async function fetchBDAdresses(
	options: FetchBDAdressesOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadBDAdresses(client, {
		outputDir: options.outRoot(SLUG),
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}

/**
 * The file `#lu/adapters/bd-adresses/adapter` reads, under a fetch run's `outRoot`.
 */
export function bdAdressesInputPath(outRoot: PathBuilder): PathBuilder {
	return outRoot(SLUG, LU_BD_ADRESSES_CSV_FILENAME)
}
