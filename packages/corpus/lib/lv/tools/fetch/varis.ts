/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Downloads the State Address Register's open data (`Valsts adrešu reģistra atvērtie dati`) for the
 * `lv-varis` adapter.
 *
 * Valsts zemes dienests republishes every table of the dataset `varis-atvertie-dati` on data.gov.lv,
 * and a republish can move a resource's URL. The fetcher therefore asks the portal's CKAN API for the
 * dataset's resources and picks each table by the file name its URL ends in, rather than holding URLs
 * that the next republish may retire. The manifest records, per file, the resource URL, the CKAN
 * `last_modified`, the byte count and the SHA-256, and once for the dataset the license id the portal
 * states, so a corpus row traces to one publication.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { LV_VARIS_ADAPTER_ID, LV_VARIS_LICENSE, VARIS_TABLES, type VarisTable } from "#lv/adapters/varis/adapter"
import type { CKANResource } from "#ro/tools/fetch/retea-scolara"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"

/**
 * The data.gov.lv dataset that holds the register's tables.
 */
export const LV_VARIS_DATASET_ID = "varis-atvertie-dati"

/**
 * The CKAN call that lists the dataset's resources and its license.
 */
export const LV_VARIS_PACKAGE_URL = `https://data.gov.lv/dati/api/3/action/package_show?id=${LV_VARIS_DATASET_ID}`

const SLUG = LV_VARIS_ADAPTER_ID

interface CKANPackage {
	license_id?: string | null
	license_title?: string | null
	organization?: { title?: string | null } | null
	resources?: CKANResource[]
}

/**
 * One downloaded table, as the manifest records it.
 */
export interface VarisFileManifest extends SourceManifest {
	resource_name: string | null
	last_modified: string | null
}

/**
 * The manifest written beside the tables.
 */
export interface VarisManifest {
	source: string
	dataset_url: string
	publisher: string | null
	license_id: string | null
	license_title: string | null
	files: VarisFileManifest[]
}

/**
 * The resource whose URL path ends in `/<filename>`.
 *
 * The dataset also lists each table's `_his` history file and a `_metadata.json` beside it,
 * so the match is on the whole final path segment rather than on a prefix.
 *
 * @throws When the dataset lists no resource for `filename`.
 */
export function resourceForFile(resources: readonly CKANResource[], filename: string): CKANResource {
	const found = resources.find((resource) => {
		const path = URL.canParse(resource.url) ? new URL(resource.url).pathname : resource.url

		return path.split("/").at(-1) === filename
	})

	if (!found) throw new Error(`${SLUG}: dataset ${LV_VARIS_DATASET_ID} lists no resource named ${filename}`)

	return found
}

export interface DownloadVarisOptions {
	outputDir: PathBuilderLike
	/**
	 * The tables to download.
	 * Defaults to every table the adapter reads.
	 */
	tables?: readonly VarisTable[]
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

export async function downloadVaris(
	client: Pick<APIClient, "fetch">,
	options: DownloadVarisOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const manifestPath = destDir("MANIFEST.json")

	await makeDirectories(destDir)
	report?.(`=== ${SLUG}`)

	const response = await client.fetch<{ result: CKANPackage }>({ url: LV_VARIS_PACKAGE_URL, signal: options.signal })
	const pkg = response.data.result

	if (pkg.license_id !== LV_VARIS_LICENSE) {
		report?.(`  the portal now states license ${pkg.license_id ?? "none"}, not ${LV_VARIS_LICENSE}`)
	}

	const recorded = await readManifest<VarisManifest>(manifestPath)
	const recordedFiles = new Map((recorded?.files ?? []).map((entry) => [entry.filename, entry]))
	const files: VarisFileManifest[] = []
	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	for (const table of options.tables ?? Object.values(VARIS_TABLES)) {
		if (options.signal?.aborted) break

		const resource = resourceForFile(pkg.resources ?? [], table)
		const lastModified = resource.last_modified ?? resource.created ?? null
		const dest = destDir(table)
		const previous = recordedFiles.get(table)
		const stat = await tryStat(dest)

		if (
			!options.force &&
			previous &&
			stat &&
			previous.source_url === resource.url &&
			previous.last_modified === lastModified &&
			previous.bytes === stat.size
		) {
			report?.(`  ${table} present, and the portal lists the same upload`)
			files.push(previous)

			summary.skipped++

			continue
		}

		const { bytes } = await downloadToFile({
			url: resource.url,
			dest,
			retries: options.retries,
			retryDelayMs: options.retryDelayMs,
			report,
		})

		const sha256 = await sha256File(dest)

		report?.(`  ✓ ${table} ${ByteFormatter.formatIEC(bytes)} sha256=${sha256}`)

		files.push({
			source_url: resource.url,
			filename: table,
			bytes,
			sha256,
			downloaded_at: new Date().toISOString(),
			resource_name: resource.name?.trim() ?? null,
			last_modified: lastModified,
		})

		summary.fetched++
	}

	const manifest: VarisManifest = {
		source: SLUG,
		dataset_url: LV_VARIS_PACKAGE_URL,
		publisher: pkg.organization?.title ?? null,
		license_id: pkg.license_id ?? null,
		license_title: pkg.license_title ?? null,
		files,
	}

	await writeManifest(manifestPath, manifest)

	return summary
}

/**
 * The directory the adapter reads under a fetch root.
 */
export function varisInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)
}

export interface FetchVarisOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	signal?: AbortSignal
}

export async function fetchVaris(options: FetchVarisOptions, report?: (line: string) => void): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned, so the client is disposed after the downloads finish.
	return await downloadVaris(client, {
		outputDir: options.outRoot(SLUG),
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}
