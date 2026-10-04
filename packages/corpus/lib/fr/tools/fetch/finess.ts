/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Download the FINESS establishment extract for the `fr-finess-overseas` adapter.
 *
 * The extract is a resource of the data.gouv.fr dataset
 * `finess-extraction-du-fichier-des-etablissements`, whose API record at
 * `https://www.data.gouv.fr/api/1/datasets/finess-extraction-du-fichier-des-etablissements/` lists
 * every resource with its URL, `last_modified`, `filesize` and a SHA-1 `checksum`. The establishment
 * extract is the resource whose file is named `etalab-cs1100502-stock-<date>-<time>.csv`; the
 * geolocated extract `etalab-cs1100507-…` and the history archive sit beside it and are not read.
 * {@linkcode selectFinessExtract} picks the newest establishment extract the record lists, so the
 * fetcher follows a republication without a code change.
 *
 * The publisher froze the extract at data dated 2026-05-04 and states on the dataset page that it
 * will not be updated again, so a re-run normally finds the recorded file current and makes no
 * transfer.
 *
 * The transfer is checked against the record: the byte count against `filesize` and the SHA-1
 * against `checksum`. The record's SHA-1 can describe an earlier upload of the same object. Measured
 * on 2026-10-03, the record states `d3c2c0e68a413974dffbe0aabf093e3f40414967` and `last_modified`
 * 2026-05-12, while the object `static.data.gouv.fr` serves has `last-modified` 2026-07-02, SHA-1
 * `8be4bdc362f3f382e3a7de2a26da6c3a5e6074f3` on two separate transfers, the record's 35,786,629
 * bytes, and an ETag equal to its MD5. Where the SHA-1 disagrees, the storage host's ETag MD5
 * decides, and the manifest records all three digests. A file that matches neither is an
 * interrupted transfer or an error page and is removed rather than recorded. The manifest records the SHA-256 the corpus tooling compares,
 * the resource's `last_modified`, and the extract's own first line (`finess;etalab;111;2026-05-12`),
 * which carries the extraction date Licence Ouverte's attribution names.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { readFileHead, readLocalBuffer, tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { createHash, md5File, sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { FR_FINESS_ADAPTER_ID, FR_FINESS_ATTRIBUTION, FR_FINESS_LICENSE } from "#fr/adapters/finess/adapter"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, loadCollectionFiles, writeManifest } from "#tools/fetch/download"

/**
 * The dataset's slug on data.gouv.fr.
 */
export const FINESS_DATASET_SLUG = "finess-extraction-du-fichier-des-etablissements"

/**
 * The dataset's API record, which lists its resources.
 */
export const FINESS_DATASET_API_URL = `https://www.data.gouv.fr/api/1/datasets/${FINESS_DATASET_SLUG}/`

/**
 * The dataset's page, which states the license.
 */
export const FINESS_DATASET_PAGE_URL = `https://www.data.gouv.fr/datasets/${FINESS_DATASET_SLUG}`

/**
 * The file name of an establishment extract, as the resource URL ends.
 */
const ESTABLISHMENT_EXTRACT = /\/(etalab-cs1100502-stock-\d{8}-\d{4}\.csv)$/u

/**
 * The opening of the extract's comment line, which an HTML error page does not have.
 */
const EXTRACT_HEADER = "finess;"

/**
 * The fields of a data.gouv.fr resource the fetcher reads.
 */
export interface DataGouvResource {
	id: string
	title?: string
	url: string
	last_modified: string
	filesize?: number | null
	checksum?: { type: string; value: string } | null
}

/**
 * The fields of a data.gouv.fr dataset record the fetcher reads.
 */
export interface DataGouvDataset {
	license?: string
	resources: readonly DataGouvResource[]
}

/**
 * What the manifest records for the extract, beyond {@linkcode SourceManifest}'s five fields.
 */
export interface FinessExtractManifest extends SourceManifest {
	resource_id: string
	resource_last_modified: string
	/**
	 * The license id data.gouv.fr states for the dataset, `fr-lo` when this module was written.
	 */
	dataset_license: string | null
	/**
	 * The extract's first line, which ends with the extraction date.
	 */
	extract_header: string
	/**
	 * The SHA-1 of the bytes written.
	 */
	sha1: string
	/**
	 * The SHA-1 the dataset record states, or `null` where it states none.
	 */
	record_sha1: string | null
	/**
	 * The MD5 the storage host's ETag stated, read only when the record's SHA-1 disagreed with the bytes.
	 */
	served_md5: string | null
}

/**
 * The MD5 a storage host's ETag states for an object, or `null` when it sends no ETag of that shape.
 *
 * `static.data.gouv.fr` answers `etag: W/"<md5 hex>"`.
 */
export async function readServedMD5(client: Pick<APIClient, "fetch">, url: string): Promise<string | null> {
	const response = await client.fetch<unknown>({ method: "head", url })
	const headers = response.headers as Record<string, string> | undefined
	const match = /^(?:W\/)?"([\da-f]{32})"$/iu.exec(headers?.["etag"] ?? "")

	return match ? match[1]!.toLowerCase() : null
}

/**
 * The newest establishment extract a dataset record lists.
 *
 * @throws When the record lists none, so a renamed resource reports itself rather than reading as no data.
 */
export function selectFinessExtract(dataset: DataGouvDataset): DataGouvResource & { filename: string } {
	const extracts = dataset.resources
		.map((resource) => ({ resource, match: ESTABLISHMENT_EXTRACT.exec(resource.url) }))
		.filter((entry) => entry.match !== null)
		.toSorted((left, right) => left.resource.last_modified.localeCompare(right.resource.last_modified))

	const newest = extracts.at(-1)

	if (!newest) {
		throw new Error(
			`${FR_FINESS_ADAPTER_ID}: ${FINESS_DATASET_API_URL} lists no resource named etalab-cs1100502-stock-<date>.csv`
		)
	}

	return { ...newest.resource, filename: newest.match![1]! }
}

/**
 * Read the dataset's API record.
 */
export async function readFinessDataset(client: Pick<APIClient, "fetch">): Promise<DataGouvDataset> {
	const { data } = await client.fetch<DataGouvDataset | string>({ url: FINESS_DATASET_API_URL })

	if (typeof data !== "object" || data === null || !Array.isArray(data.resources)) {
		throw new Error(`${FR_FINESS_ADAPTER_ID}: ${FINESS_DATASET_API_URL} did not answer a dataset record`)
	}

	return data
}

/**
 * The SHA-1 of a file, which is the digest data.gouv.fr publishes for a resource.
 */
async function sha1File(path: PathBuilderLike): Promise<string> {
	return createHash("sha1")
		.update(await readLocalBuffer(path))
		.digest("hex")
}

export interface DownloadFinessOptions {
	/**
	 * Where the extract and the manifest are written.
	 */
	outputDir: PathBuilderLike
	/**
	 * Download even where the manifest records the same resource and the file is on disk.
	 */
	force?: boolean
	retryDelayMs?: number
	report?: (line: string) => void
}

export type FetchFinessOptions = BaseFetchOptions & Pick<DownloadFinessOptions, "force">

/**
 * The directory `#fr/adapters/finess/adapter` reads under a fetch root.
 */
export function finessInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(FR_FINESS_ADAPTER_ID)
}

/**
 * Download the newest establishment extract into `options.outputDir` and record it in the manifest.
 *
 * Re-runnable: the transfer is skipped when the manifest records the same resource URL
 * and `last_modified` and the file is on disk at the recorded length.
 */
export async function downloadFinessExtract(
	client: Pick<APIClient, "fetch">,
	options: DownloadFinessOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	await makeDirectories(destDir)

	report?.(`=== ${FR_FINESS_ADAPTER_ID}`)

	const dataset = await readFinessDataset(client)
	const resource = selectFinessExtract(dataset)
	const manifestPath = destDir("MANIFEST.json")
	const recorded = (await loadCollectionFiles(manifestPath)) as Map<string, FinessExtractManifest>
	const previous = recorded.get(resource.filename)
	const dest = destDir(resource.filename)

	report?.(`  ${resource.filename}: last_modified ${resource.last_modified}, filesize ${resource.filesize ?? "absent"}`)

	if (
		!options.force &&
		previous?.source_url === resource.url &&
		previous.resource_last_modified === resource.last_modified &&
		(await tryStat(dest))?.size === previous.bytes
	) {
		report?.(`  ✓ ${resource.filename} already current — no download.`)

		summary.skipped++

		return summary
	}

	const fail = async (reason: string): Promise<FetchSummary> => {
		report?.(`  ✗ ${resource.filename}: ${reason}`)
		await removePathIfPresent(dest)

		summary.failed++
		summary.failedCodes.push(resource.filename)

		return summary
	}

	let bytes: number

	try {
		const written = await downloadToFile({
			url: resource.url,
			dest,
			retries: 3,
			retryDelayMs: options.retryDelayMs,
			report,
		})

		bytes = written.bytes
	} catch (error) {
		return fail(`download failed: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (typeof resource.filesize === "number" && resource.filesize !== bytes) {
		return fail(`the record states ${resource.filesize} bytes and ${bytes} arrived`)
	}

	const sha1 = await sha1File(dest)
	let servedMD5: string | null = null

	if (resource.checksum?.type === "sha1" && sha1 !== resource.checksum.value) {
		// The record's digest can describe an earlier upload of the same object.
		// The storage host's ETag is the MD5 of the bytes it serves now, so it decides.
		servedMD5 = await readServedMD5(client, resource.url)
		const md5 = await md5File(dest)

		if (servedMD5 !== md5) {
			return fail(
				`SHA-1 ${sha1} differs from the record's ${resource.checksum.value}, ` +
					`and MD5 ${md5} differs from the served ETag ${servedMD5 ?? "(absent)"}`
			)
		}

		report?.(
			`  ! ${resource.filename}: the record's SHA-1 ${resource.checksum.value} describes other bytes; ` +
				`the transfer matches the served ETag MD5 ${servedMD5} and the record's filesize`
		)
	}

	const head = await readFileHead(dest, 256)
	const header = head.split(/\r?\n/u)[0] ?? ""

	if (!header.startsWith(EXTRACT_HEADER)) {
		return fail(`the file opens with ${stringifyJSON(header.slice(0, 40))}, not the extract's comment line`)
	}

	const entry: FinessExtractManifest = {
		source_url: resource.url,
		downloaded_at: new Date().toISOString(),
		filename: resource.filename,
		sha256: await sha256File(dest),
		bytes,
		resource_id: resource.id,
		resource_last_modified: resource.last_modified,
		dataset_license: dataset.license ?? null,
		extract_header: header,
		sha1,
		record_sha1: resource.checksum?.type === "sha1" ? resource.checksum.value : null,
		served_md5: servedMD5,
	}

	recorded.set(resource.filename, entry)

	const manifest: SourceCollectionManifest = {
		source: FR_FINESS_ADAPTER_ID,
		source_url: FINESS_DATASET_PAGE_URL,
		license: FR_FINESS_LICENSE,
		attribution: FR_FINESS_ATTRIBUTION,
		downloaded_at: entry.downloaded_at,
		files: [...recorded.values()].toSorted((left, right) => left.filename.localeCompare(right.filename)),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${resource.filename}: ${ByteFormatter.formatIEC(bytes)}, sha256 ${entry.sha256}`)
	report?.(`  MANIFEST written to ${manifestPath.toString()}`)

	summary.fetched++

	return summary
}

/**
 * Download the FINESS establishment extract into `<outRoot>/fr-finess-overseas/`.
 *
 * The registry entry point.
 * `#fr/adapters/finess/adapter` is pointed at {@linkcode finessInputPath},
 * and reads the newest extract in it.
 */
export async function fetchFinessOverseas(
	options: FetchFinessOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: FR_FINESS_ADAPTER_ID, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadFinessExtract(client, {
		outputDir: finessInputPath(options.outRoot),
		force: options.force,
		retryDelayMs: options.retryDelayMs,
		report,
	})
}
