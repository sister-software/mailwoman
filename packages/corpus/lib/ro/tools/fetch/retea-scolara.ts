/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Downloads Romania's school network workbook for the `ro-retea-scolara` adapter.
 *
 * The Ministry of Education publishes a new workbook each school year under one data.gov.ro dataset,
 * and each upload has a new resource URL. The fetcher therefore asks the portal's CKAN API for the
 * dataset's resources and downloads the newest XLSX, rather than holding a URL that the next upload
 * retires. The manifest records the resource URL, the CKAN `last_modified` and the license id the
 * portal states, so a corpus row traces to one upload.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { RO_RETEA_SCOLARA_ADAPTER_ID, RO_RETEA_SCOLARA_LICENSE } from "#ro/adapters/retea-scolara/adapter"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"

/**
 * The data.gov.ro dataset that holds every school year's workbook.
 */
export const RO_RETEA_SCOLARA_DATASET_ID = "69392a50-5750-4a54-90c1-d461de44da6d"

/**
 * The CKAN call that lists the dataset's resources and its license.
 */
export const RO_RETEA_SCOLARA_PACKAGE_URL = `https://data.gov.ro/api/3/action/package_show?id=${RO_RETEA_SCOLARA_DATASET_ID}`

/**
 * The file name the adapter reads, whatever the upload's own name.
 */
export const RO_RETEA_SCOLARA_FILENAME = "retea-scolara.xlsx"

const SLUG = RO_RETEA_SCOLARA_ADAPTER_ID

/**
 * One CKAN resource, as `package_show` lists it.
 */
export interface CKANResource {
	url: string
	format?: string | null
	name?: string | null
	last_modified?: string | null
	created?: string | null
}

interface CKANPackage {
	license_id?: string | null
	resources?: CKANResource[]
}

export interface ReteaScolaraManifest extends SourceManifest {
	resource_name: string | null
	last_modified: string | null
	license_id: string | null
}

/**
 * The newest XLSX resource, by its `last_modified` or else its `created` date.
 *
 * @throws When the dataset lists no XLSX resource.
 */
export function newestXLSXResource(resources: readonly CKANResource[]): CKANResource {
	const dated = resources
		.filter((resource) => (resource.format ?? "").toUpperCase() === "XLSX")
		.map((resource) => ({ resource, at: resource.last_modified ?? resource.created ?? "" }))
		.toSorted((a, b) => b.at.localeCompare(a.at))

	if (!dated.length) throw new Error(`${SLUG}: dataset ${RO_RETEA_SCOLARA_DATASET_ID} lists no XLSX resource`)

	return dated[0]!.resource
}

export interface DownloadReteaScolaraOptions {
	outputDir: PathBuilderLike
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

export async function downloadReteaScolara(
	client: Pick<APIClient, "fetch">,
	options: DownloadReteaScolaraOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const workbookPath = destDir(RO_RETEA_SCOLARA_FILENAME)
	const manifestPath = destDir("MANIFEST.json")

	await makeDirectories(destDir)
	report?.(`=== ${SLUG}`)

	const response = await client.fetch<{ result: CKANPackage }>({
		url: RO_RETEA_SCOLARA_PACKAGE_URL,
		signal: options.signal,
	})

	const pkg = response.data.result
	const resource = newestXLSXResource(pkg.resources ?? [])
	const lastModified = resource.last_modified ?? resource.created ?? null

	if (pkg.license_id !== RO_RETEA_SCOLARA_LICENSE) {
		report?.(`  the portal now states license ${pkg.license_id ?? "none"}, not ${RO_RETEA_SCOLARA_LICENSE}`)
	}

	const recorded = await readManifest<ReteaScolaraManifest>(manifestPath)
	const stat = await tryStat(workbookPath)

	if (
		!options.force &&
		recorded &&
		stat &&
		recorded.source_url === resource.url &&
		recorded.last_modified === lastModified &&
		recorded.bytes === stat.size
	) {
		report?.(`  present, and the portal lists the same upload`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	const { bytes } = await downloadToFile({
		url: resource.url,
		dest: workbookPath,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		report,
	})

	const sha256 = await sha256File(workbookPath)

	report?.(`  ✓ ${resource.name ?? resource.url} ${ByteFormatter.formatIEC(bytes)} sha256=${sha256}`)

	const manifest: ReteaScolaraManifest = {
		source_url: resource.url,
		filename: RO_RETEA_SCOLARA_FILENAME,
		bytes,
		sha256,
		downloaded_at: new Date().toISOString(),
		resource_name: resource.name ?? null,
		last_modified: lastModified,
		license_id: pkg.license_id ?? null,
	}

	await writeManifest(manifestPath, manifest)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The workbook path the adapter reads under a fetch root.
 */
export function reteaScolaraInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, RO_RETEA_SCOLARA_FILENAME)
}

export interface FetchReteaScolaraOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	signal?: AbortSignal
}

export async function fetchReteaScolara(
	options: FetchReteaScolaraOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned, so the client is disposed after the download finishes.
	return await downloadReteaScolara(client, {
		outputDir: options.outRoot(SLUG),
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}
