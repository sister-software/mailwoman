/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads the three OS OpenData products the `gb-os-open` adapter joins, from the OS Downloads API.
 *
 *   The API serves OpenData without a key. `GET /products/<id>/downloads` lists one archive per
 *   format and area with its OS-published MD5, and each archive is checked against that MD5 after
 *   transfer. A present archive whose MD5 already matches is kept rather than downloaded again.
 *
 *   Each archive is unpacked into the subdirectory the adapter reads, `code-point-open/`,
 *   `open-names/` or `open-roads/`, so the fetch root is the adapter's `inputPath`. The archive
 *   stays beside its members, because its digest is the value the address-source register records.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { md5File, sha256File } from "@mailwoman/core/hash"
import { OS_DOWNLOADS_API_BASE, type OSDownload } from "@mailwoman/spatial/gb/os-downloads"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { GB_OS_OPEN_ADAPTER_ID, GB_OS_OPEN_PRODUCT_DIRECTORIES } from "#gb/adapters/os-open/adapter"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, writeManifest } from "#tools/fetch/download"

/**
 * The license all three products are published under.
 */
export const GB_OS_OPEN_LICENSE_NAME = "Open Government Licence v3.0"

/**
 * The attribution OGL v3 requires, in the wording OS asks for on Code-Point Open,
 * which also carries Royal Mail and ONS data.
 */
export const GB_OS_OPEN_ATTRIBUTION =
	"Contains OS data © Crown copyright and database right. Contains Royal Mail data © Royal Mail copyright and database right. Contains National Statistics data © Crown copyright and database right."

/**
 * One product the adapter reads: its OS Downloads API id, the archive format,
 * and the subdirectory it unpacks into.
 */
export interface OSOpenProduct {
	productID: string
	format: string
	directory: string
}

/**
 * The three products, in the order they are fetched.
 */
export const GB_OS_OPEN_PRODUCTS: readonly OSOpenProduct[] = [
	{ productID: "CodePointOpen", format: "CSV", directory: GB_OS_OPEN_PRODUCT_DIRECTORIES.codePointOpen },
	{ productID: "OpenNames", format: "CSV", directory: GB_OS_OPEN_PRODUCT_DIRECTORIES.openNames },
	{ productID: "OpenRoads", format: "GML", directory: GB_OS_OPEN_PRODUCT_DIRECTORIES.openRoads },
]

/**
 * The manifest entry for one product's archive.
 */
export interface OSOpenFileManifest extends SourceManifest {
	product_id: string
	format: string
	md5: string
	members: number
}

/**
 * The archive of `product` among the listed downloads, the Great Britain one where an area is stated.
 *
 * @throws Naming the formats offered, when none matches.
 */
export function selectOSDownload(product: OSOpenProduct, downloads: readonly OSDownload[]): OSDownload {
	const matches = downloads.filter((download) => download.format === product.format)
	const chosen = matches.find((download) => download.area === "GB") ?? (matches.length === 1 ? matches[0] : null)

	if (!chosen) {
		throw new Error(
			`${GB_OS_OPEN_ADAPTER_ID}: OS Downloads API lists no single ${product.format} archive for ${product.productID} ` +
				`(listed: ${downloads.map((download) => `${download.format}/${download.area}`).join(", ") || "nothing"})`
		)
	}

	return chosen
}

/**
 * The archives the OS Downloads API lists for one product.
 */
export async function readOSDownloads(
	client: Pick<APIClient, "fetch">,
	product: OSOpenProduct,
	options: { signal?: AbortSignal } = {}
): Promise<OSDownload[]> {
	const { data } = await client.fetch<OSDownload[]>({
		method: "GET",
		url: `${OS_DOWNLOADS_API_BASE}/products/${product.productID}/downloads`,
		timeout: 60_000,
		signal: options.signal,
	})

	if (!Array.isArray(data)) {
		throw new TypeError(
			`${GB_OS_OPEN_ADAPTER_ID}: OS Downloads API answered ${product.productID} with no download list`
		)
	}

	return data
}

/**
 * Downloads and unpacks one product.
 */
export async function downloadOSOpenProduct(
	client: Pick<APIClient, "fetch">,
	product: OSOpenProduct,
	options: {
		outputDir: PathBuilderLike
		force?: boolean
		retries?: number
		retryDelayMs?: number
		signal?: AbortSignal
		report?: (line: string) => void
	}
): Promise<{ entry: OSOpenFileManifest; downloaded: boolean }> {
	const { report } = options
	const download = selectOSDownload(product, await readOSDownloads(client, product, { signal: options.signal }))
	const productDir = PathBuilder.from(options.outputDir)(product.directory)
	const archivePath = productDir(download.fileName)

	report?.(
		`=== ${GB_OS_OPEN_ADAPTER_ID} / ${product.productID} ${download.fileName} (${ByteFormatter.formatIEC(download.size)})`
	)

	await makeDirectories(productDir)

	const present = options.force ? null : await md5File(archivePath).catch(() => null)
	const downloaded = present !== download.md5

	if (downloaded) {
		await downloadToFile({
			url: download.url,
			dest: archivePath,
			retries: options.retries,
			retryDelayMs: options.retryDelayMs,
			report,
		})

		const md5 = await md5File(archivePath)

		if (md5 !== download.md5) {
			throw new Error(
				`${GB_OS_OPEN_ADAPTER_ID}: ${download.fileName} has md5 ${md5}, and OS publishes ${download.md5} for it`
			)
		}
	} else {
		report?.(`  present, and its md5 matches the published ${download.md5}`)
	}

	const members = await extractZipEntries(archivePath, productDir, { skipExisting: true })
	const sha256 = await sha256File(archivePath)

	report?.(`  ${members.length} members unpacked  sha256=${sha256}`)

	return {
		entry: {
			source_url: download.url,
			filename: download.fileName,
			product_id: product.productID,
			format: product.format,
			bytes: download.size,
			md5: download.md5,
			sha256,
			members: members.length,
			downloaded_at: new Date().toISOString(),
		},
		downloaded,
	}
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchGBOSOpenOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	signal?: AbortSignal
}

/**
 * The registry entry: fetches all three products and writes `MANIFEST.json` at the adapter's input root.
 *
 * A product that fails is counted and the others are still taken.
 */
export async function fetchGBOSOpen(
	options: FetchGBOSOpenOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const outputDir = options.outRoot(GB_OS_OPEN_ADAPTER_ID)
	const files: OSOpenFileManifest[] = []
	const failedCodes: string[] = []

	let fetched = 0
	let skipped = 0

	await using client = new APIClient({ displayName: GB_OS_OPEN_ADAPTER_ID, minRequestIntervalMs: 250, retry: true })

	for (const product of GB_OS_OPEN_PRODUCTS) {
		if (options.signal?.aborted) break

		try {
			const { entry, downloaded } = await downloadOSOpenProduct(client, product, {
				outputDir,
				force: options.force,
				retries: options.retries,
				retryDelayMs: options.retryDelayMs,
				signal: options.signal,
				report,
			})

			files.push(entry)

			if (downloaded) {
				fetched += 1
			} else {
				skipped += 1
			}
		} catch (error) {
			report?.(`  ✗ ${product.productID}: ${error instanceof Error ? error.message : String(error)}`)

			failedCodes.push(product.productID)
		}
	}

	const manifest: SourceCollectionManifest = {
		source: GB_OS_OPEN_ADAPTER_ID,
		source_url: OS_DOWNLOADS_API_BASE,
		license: GB_OS_OPEN_LICENSE_NAME,
		attribution: GB_OS_OPEN_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
		files,
	}

	await writeManifest(outputDir("MANIFEST.json"), manifest)

	report?.(`  MANIFEST written to ${outputDir("MANIFEST.json")}`)

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}
