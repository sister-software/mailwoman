/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Download the CORDIS project archives for the `cordis` adapter.
 *
 * CORDIS serves one CSV archive per framework programme at
 * `https://cordis.europa.eu/data/cordis-<programme>projects-csv.zip`, where the programme is `fp7`,
 * `h2020` or `HORIZON` (Horizon Europe), the spelling the host serves. These are the distributions the
 * data.europa.eu records `cordisfp7projects`, `cordish2020projects` and
 * `cordis-eu-research-projects-under-horizon-europe-2021-2027` link. Each archive holds an
 * `organization.csv` beside the project, topic and link tables, and the adapter reads that member
 * straight out of the archive, so the archive is what this module keeps.
 *
 * The acquisition belongs under a `tools/` root. `@mailwoman/corpus` is one of the
 * `TOOLING_PACKAGES` in `dependency-cruiser.config.mjs`, which keep their tooling under `lib/`.
 *
 * Measured on 2026-10-03, the host answers `HEAD` with `accept-ranges: bytes`, a `content-length`
 * and a `last-modified` for each archive: `fp7` 32,953,397 bytes last modified `Thu, 02 Jan 2025
 * 10:27:58 GMT`, `h2020` 55,219,250 bytes and `HORIZON` 36,908,998 bytes, both last modified on
 * 22 September 2026. The re-run check compares that pair against the manifest, so a rerun makes
 * one small request per archive, and an interrupted transfer resumes through
 * {@linkcode resumableDownload}.
 *
 * A delivered archive is checked for its `organization.csv` member before the manifest records it,
 * so an error page served under the archive's name never reaches the adapter.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import {
	CORDIS_ADAPTER_ID,
	CORDIS_ATTRIBUTION,
	CORDIS_LICENSE,
	CORDIS_ORGANIZATION_MEMBER,
} from "#adapters/cordis/adapter"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { loadCollectionFiles, resumableDownload, writeManifest } from "#tools/fetch/download"

/**
 * The programmes CORDIS publishes an archive for, in the spelling the host serves.
 */
export const CORDIS_PROGRAMMES: readonly string[] = ["fp7", "h2020", "HORIZON"]

/**
 * The download URL for one programme's archive.
 */
export function cordisArchiveURL(programme: string): string {
	return `https://cordis.europa.eu/data/cordis-${programme}projects-csv.zip`
}

/**
 * The file name one programme's archive is kept under. It is the URL's own last segment.
 */
export function cordisArchiveFilename(programme: string): string {
	return `cordis-${programme}projects-csv.zip`
}

/**
 * The page whose license statement the adapter quotes.
 */
export const CORDIS_LEGAL_NOTICE_URL = "https://cordis.europa.eu/about/legal"

/**
 * The directory the archives are written under. It is the adapter's `inputPath`.
 */
const SLUG = CORDIS_ADAPTER_ID

/**
 * What the manifest records per archive.
 *
 * {@linkcode SourceManifest}'s five fields describe the archive as it arrived.
 * `last_modified` is what the re-run check compares before it downloads the body again.
 */
export interface CORDISArchiveManifest extends SourceManifest {
	/**
	 * The `last-modified` the host served the archive under, or `null` where it served none.
	 */
	last_modified: string | null
}

/**
 * What the host states about one archive without sending it.
 */
export interface CORDISArchiveHead {
	lastModified: string | null
	contentLength: number | null
}

/**
 * Read what the host states about one archive.
 *
 * A header the host does not send is reported as `null` rather than raised on,
 * and the caller then downloads rather than reading the absence as a match.
 */
export async function readCORDISArchiveHead(
	client: Pick<APIClient, "fetch">,
	programme: string
): Promise<CORDISArchiveHead> {
	const response = await client.fetch<unknown>({ method: "head", url: cordisArchiveURL(programme) })
	const headers = response.headers as Record<string, string> | undefined
	const length = headers?.["content-length"]

	return {
		lastModified: headers?.["last-modified"] ?? null,
		contentLength: length !== undefined && /^\d+$/u.test(length) ? Number(length) : null,
	}
}

/**
 * Whether an archive on disk is still the one the manifest describes and the host still serves.
 *
 * The `HEAD` decides first, then the file's own length, then, when asked, its digest.
 */
export async function isCORDISArchiveCurrent(
	recorded: CORDISArchiveManifest | undefined,
	head: CORDISArchiveHead,
	path: PathBuilderLike,
	verifyDigest: boolean
): Promise<boolean> {
	if (!recorded) return false

	if (head.lastModified === null && head.contentLength === null) return false

	if (head.lastModified !== null && head.lastModified !== recorded.last_modified) return false

	if (head.contentLength !== null && head.contentLength !== recorded.bytes) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	if (!verifyDigest) return true

	return (await sha256File(path)) === recorded.sha256
}

export interface DownloadCORDISOptions {
	/**
	 * Where the archives and the manifest are written.
	 * The directory itself is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Which programmes to fetch.
	 * Defaults to {@linkcode CORDIS_PROGRAMMES}.
	 */
	programmes?: readonly string[]
	/**
	 * Re-read each archive's sha256 on a re-run instead of comparing its byte count.
	 */
	verifyDigest?: boolean
	/**
	 * Download even where the `HEAD` agrees with the manifest.
	 */
	force?: boolean
	/**
	 * Pause between range attempts, in milliseconds.
	 */
	retryDelayMs?: number
	report?: (line: string) => void
}

export type FetchCORDISOptions = BaseFetchOptions & Omit<DownloadCORDISOptions, "outputDir" | "report">

/**
 * The directory `#adapters/cordis/adapter` reads under a fetch root.
 */
export function cordisInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)
}

/**
 * Download each requested programme's archive into `options.outputDir` beside one manifest.
 *
 * Re-runnable per archive: one whose `HEAD` matches the manifest and whose file is
 * still on disk at the recorded length makes no request for the body.
 */
export async function downloadCORDIS(
	client: Pick<APIClient, "fetch">,
	options: DownloadCORDISOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const programmes = options.programmes?.length ? options.programmes : CORDIS_PROGRAMMES

	await makeDirectories(destDir)

	const manifestPath = destDir("MANIFEST.json")
	const recorded = (await loadCollectionFiles(manifestPath)) as Map<string, CORDISArchiveManifest>
	const written = new Map<string, CORDISArchiveManifest>(recorded)
	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	report?.(`=== ${SLUG}`)

	for (const programme of programmes) {
		const filename = cordisArchiveFilename(programme)
		const archivePath = destDir(filename)
		const url = cordisArchiveURL(programme)

		let head: CORDISArchiveHead

		try {
			head = await readCORDISArchiveHead(client, programme)
		} catch (error) {
			report?.(`  ✗ ${programme}: ${error instanceof Error ? error.message : String(error)}`)

			summary.failed++
			summary.failedCodes.push(programme)

			continue
		}

		report?.(
			`  ${programme}: ${head.contentLength === null ? "no content-length" : ByteFormatter.formatIEC(head.contentLength)}` +
				`, last-modified ${head.lastModified ?? "absent"}`
		)

		const current =
			!options.force &&
			(await isCORDISArchiveCurrent(recorded.get(filename), head, archivePath, options.verifyDigest ?? false))

		if (current) {
			report?.(`  ✓ ${programme} already current — no download.`)

			summary.skipped++

			continue
		}

		let bytes: number

		try {
			bytes = await resumableDownload({
				url,
				dest: archivePath,
				headers: { accept: "application/zip, */*" },
				retryDelayMs: options.retryDelayMs,
				report,
			})

			const members = await listZipEntries(archivePath)

			if (!members.some((member) => member.name === CORDIS_ORGANIZATION_MEMBER)) {
				throw new Error(`the archive holds no ${CORDIS_ORGANIZATION_MEMBER}`)
			}
		} catch (error) {
			report?.(`  ✗ ${programme}: ${error instanceof Error ? error.message : String(error)}`)
			await removePathIfPresent(archivePath)

			summary.failed++
			summary.failedCodes.push(programme)

			continue
		}

		if (head.contentLength !== null && head.contentLength !== bytes) {
			report?.(
				`  ! ${programme}: the HEAD stated ${head.contentLength} bytes and ${bytes} arrived, ` +
					`so the archive was republished between the two requests`
			)
		}

		written.set(filename, {
			source_url: url,
			downloaded_at: new Date().toISOString(),
			filename,
			sha256: await sha256File(archivePath),
			bytes,
			last_modified: head.lastModified,
		})

		report?.(`  ✓ ${programme}: ${ByteFormatter.formatIEC(bytes)}`)

		summary.fetched++
	}

	const manifest: SourceCollectionManifest = {
		source: SLUG,
		source_url: CORDIS_LEGAL_NOTICE_URL,
		license: CORDIS_LICENSE,
		attribution: CORDIS_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
		files: [...written.values()].toSorted((left, right) => left.filename.localeCompare(right.filename)),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  MANIFEST written to ${manifestPath.toString()}`)

	return summary
}

/**
 * Download the CORDIS archives into `<outRoot>/cordis/`.
 *
 * The registry entry point.
 */
export async function fetchCORDIS(options: FetchCORDISOptions, report?: (line: string) => void): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadCORDIS(client, {
		outputDir: options.outRoot(SLUG),
		programmes: options.programmes,
		verifyDigest: options.verifyDigest,
		force: options.force,
		retryDelayMs: options.retryDelayMs,
		report,
	})
}
