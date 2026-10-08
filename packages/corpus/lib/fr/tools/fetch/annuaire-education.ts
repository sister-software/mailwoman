/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Download the overseas records of the Annuaire de l'éducation for the
 * `fr-annuaire-education-overseas` adapter.
 *
 * The education ministry publishes the directory as the OpenDataSoft dataset
 * `fr-en-annuaire-education` on `data.education.gouv.fr`. Its Explore API v2.1 serves the catalog
 * record (license, `modified`, record count) at `/api/explore/v2.1/catalog/datasets/<id>` and a whole
 * or filtered export at `/exports/jsonl?where=<ODSQL>`. The fetcher asks the export for the overseas
 * departments the adapter reads: 3,145 of the dataset's 68,564 records on 2026-10-03. It
 * writes them as JSON Lines.
 *
 * Two checks keep a short transfer from reading as a small directory. The records endpoint is asked
 * for the `total_count` of the same filter before the export, and the written file must hold exactly
 * that many lines. A mismatch removes the file and fails the fetch. A re-run compares the catalog
 * record's `modified` against the manifest and makes no transfer when they agree and the file is on
 * disk at the recorded length.
 */

import { APIClient } from "@mailwoman/core/api"
import { isSuccessStatus } from "@mailwoman/core/api/responses"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import {
	FR_ANNUAIRE_EDUCATION_ADAPTER_ID,
	FR_ANNUAIRE_EDUCATION_ATTRIBUTION,
	FR_ANNUAIRE_EDUCATION_DEPARTEMENTS,
	FR_ANNUAIRE_EDUCATION_LICENSE,
} from "#fr/adapters/annuaire-education/adapter"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { DEFAULT_RETRY_DELAY_MS, loadCollectionFiles, streamDownload, writeManifest } from "#tools/fetch/download"

/**
 * The dataset's id on `data.education.gouv.fr`.
 */
export const ANNUAIRE_EDUCATION_DATASET_ID = "fr-en-annuaire-education"

/**
 * The dataset's Explore API v2.1 root.
 */
export const ANNUAIRE_EDUCATION_API_URL = `https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/${ANNUAIRE_EDUCATION_DATASET_ID}`

/**
 * The dataset's page.
 * It states the license.
 */
export const ANNUAIRE_EDUCATION_PAGE_URL = `https://data.education.gouv.fr/explore/dataset/${ANNUAIRE_EDUCATION_DATASET_ID}/`

/**
 * The file the export is written to.
 * The adapter reads it as input.
 */
export const ANNUAIRE_EDUCATION_FILENAME = "fr-en-annuaire-education-overseas.jsonl"

/**
 * The ODSQL filter selecting the overseas departments the adapter reads.
 */
export function annuaireOverseasFilter(): string {
	return `code_departement in (${FR_ANNUAIRE_EDUCATION_DEPARTEMENTS.map((code) => `"${code}"`).join(",")})`
}

/**
 * The export URL for the overseas records, as JSON Lines.
 */
export function annuaireExportURL(): string {
	return `${ANNUAIRE_EDUCATION_API_URL}/exports/jsonl?where=${encodeURIComponent(annuaireOverseasFilter())}`
}

/**
 * The records URL that answers how many records the overseas filter selects.
 */
export function annuaireCountURL(): string {
	return `${ANNUAIRE_EDUCATION_API_URL}/records?where=${encodeURIComponent(annuaireOverseasFilter())}&limit=0`
}

/**
 * The fields of the catalog record the fetcher reads.
 */
export interface AnnuaireCatalogRecord {
	metas?: {
		default?: {
			modified?: string
			license?: string
			license_url?: string
			publisher?: string
			records_count?: number
		}
	}
}

/**
 * What the manifest records for the export, beyond {@linkcode SourceManifest}'s five fields.
 */
export interface AnnuaireExportManifest extends SourceManifest {
	/**
	 * The catalog record's `modified`, which the re-run check compares.
	 */
	dataset_modified: string
	dataset_license: string | null
	dataset_license_url: string | null
	/**
	 * The record count the filter selected.
	 * The written line count must match it.
	 */
	records: number
}

/**
 * Read the catalog record's `modified`, license and publisher.
 *
 * @throws When the record states no `modified`, because the re-run check would
 * then read every run as current.
 */
export async function readAnnuaireCatalog(
	client: Pick<APIClient, "fetch">
): Promise<{ modified: string; license: string | null; licenseURL: string | null }> {
	const { data } = await client.fetch<AnnuaireCatalogRecord>({ url: ANNUAIRE_EDUCATION_API_URL })
	const metas = data?.metas?.default

	if (!metas?.modified) {
		throw new Error(
			`${FR_ANNUAIRE_EDUCATION_ADAPTER_ID}: ${ANNUAIRE_EDUCATION_API_URL} states no metas.default.modified`
		)
	}

	return { modified: metas.modified, license: metas.license ?? null, licenseURL: metas.license_url ?? null }
}

/**
 * Read how many records the overseas filter selects.
 *
 * @throws When the endpoint answers no `total_count`.
 */
export async function readAnnuaireOverseasCount(client: Pick<APIClient, "fetch">): Promise<number> {
	const { data } = await client.fetch<{ total_count?: number }>({ url: annuaireCountURL() })

	if (typeof data?.total_count !== "number") {
		throw new TypeError(`${FR_ANNUAIRE_EDUCATION_ADAPTER_ID}: ${annuaireCountURL()} answered no total_count`)
	}

	return data.total_count
}

/**
 * The number of non-empty lines in a JSON Lines file, read as a stream.
 */
export async function countJSONLines(path: PathBuilderLike): Promise<number> {
	let count = 0

	for await (const line of TextSpliterator.fromAsync(path)) {
		if (line.trim()) {
			count++
		}
	}

	return count
}

export interface DownloadAnnuaireOptions {
	/**
	 * Where the export and the manifest are written.
	 */
	outputDir: PathBuilderLike
	/**
	 * Download even where the catalog's `modified` matches the manifest.
	 */
	force?: boolean
	retryDelayMs?: number
	report?: (line: string) => void
}

export type FetchAnnuaireEducationOptions = BaseFetchOptions & Pick<DownloadAnnuaireOptions, "force">

/**
 * The file `#fr/adapters/annuaire-education/adapter` reads under a fetch root.
 */
export function annuaireEducationInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(FR_ANNUAIRE_EDUCATION_ADAPTER_ID, ANNUAIRE_EDUCATION_FILENAME)
}

/**
 * Export the overseas records into `options.outputDir` and record the export in the manifest.
 */
export async function downloadAnnuaireEducation(
	client: Pick<APIClient, "fetch">,
	options: DownloadAnnuaireOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const dest = destDir(ANNUAIRE_EDUCATION_FILENAME)
	const manifestPath = destDir("MANIFEST.json")
	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	await makeDirectories(destDir)

	report?.(`=== ${FR_ANNUAIRE_EDUCATION_ADAPTER_ID}`)

	const catalog = await readAnnuaireCatalog(client)
	const recorded = (await loadCollectionFiles(manifestPath)) as Map<string, AnnuaireExportManifest>
	const previous = recorded.get(ANNUAIRE_EDUCATION_FILENAME)

	report?.(`  catalog modified ${catalog.modified}, license ${catalog.license ?? "absent"}`)

	if (
		!options.force &&
		previous?.dataset_modified === catalog.modified &&
		(await tryStat(dest))?.size === previous.bytes
	) {
		report?.(`  ✓ ${ANNUAIRE_EDUCATION_FILENAME} already current — no download.`)

		summary.skipped++

		return summary
	}

	const fail = async (reason: string): Promise<FetchSummary> => {
		report?.(`  ✗ ${ANNUAIRE_EDUCATION_FILENAME}: ${reason}`)
		await removePathIfPresent(dest)

		summary.failed++
		summary.failedCodes.push(ANNUAIRE_EDUCATION_FILENAME)

		return summary
	}

	const expected = await readAnnuaireOverseasCount(client)

	const status = await streamDownload(annuaireExportURL(), dest, {
		headers: { accept: "application/x-ndjson, application/json, */*" },
		timeoutMs: 600_000,
		retries: 3,
		retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
	})

	if (!isSuccessStatus(status)) return fail(`export answered HTTP ${status}`)

	const lines = await countJSONLines(dest)

	if (lines !== expected) {
		return fail(`the filter selects ${expected} records and the export wrote ${lines}`)
	}

	const stat = await tryStat(dest)

	if (!stat) return fail(`the export is not at ${dest.toString()}`)

	const entry: AnnuaireExportManifest = {
		source_url: annuaireExportURL(),
		downloaded_at: new Date().toISOString(),
		filename: ANNUAIRE_EDUCATION_FILENAME,
		sha256: await sha256File(dest),
		bytes: stat.size,
		dataset_modified: catalog.modified,
		dataset_license: catalog.license,
		dataset_license_url: catalog.licenseURL,
		records: lines,
	}

	recorded.set(ANNUAIRE_EDUCATION_FILENAME, entry)

	const manifest: SourceCollectionManifest = {
		source: FR_ANNUAIRE_EDUCATION_ADAPTER_ID,
		source_url: ANNUAIRE_EDUCATION_PAGE_URL,
		license: FR_ANNUAIRE_EDUCATION_LICENSE,
		attribution: FR_ANNUAIRE_EDUCATION_ATTRIBUTION,
		downloaded_at: entry.downloaded_at,
		files: [...recorded.values()],
	}

	await writeManifest(manifestPath, manifest)

	report?.(
		`  ✓ ${ANNUAIRE_EDUCATION_FILENAME}: ${lines} records, ${ByteFormatter.formatIEC(stat.size)}, sha256 ${entry.sha256}`
	)

	report?.(`  MANIFEST written to ${manifestPath.toString()}`)

	summary.fetched++

	return summary
}

/**
 * Export the overseas records of the Annuaire de l'éducation into `<outRoot>/fr-annuaire-education-overseas/`.
 *
 * The registry entry point.
 */
export async function fetchAnnuaireEducationOverseas(
	options: FetchAnnuaireEducationOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: FR_ANNUAIRE_EDUCATION_ADAPTER_ID, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadAnnuaireEducation(client, {
		outputDir: options.outRoot(FR_ANNUAIRE_EDUCATION_ADAPTER_ID),
		force: options.force,
		retryDelayMs: options.retryDelayMs,
		report,
	})
}
