/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Download ANAC's OCDS contract releases for the `it-anac` adapter.
 *
 * The Open Contracting Partnership's Data Registry serves publication 117 at
 * `https://data.open-contracting.org/en/publication/117/download?name=<edition>.jsonl.gz`, where an
 * edition is a year, `undated`, or `full` for every year in one file. Each file is JSON Lines, one
 * OCDS release per line, which is the shape `#it/adapters/anac/adapter` reads.
 *
 * The acquisition belongs under a `tools/` root. `@mailwoman/corpus` is one of the
 * `TOOLING_PACKAGES` in `dependency-cruiser.config.mjs`, which keep their tooling under `lib/`, so
 * this module sits beside `#fi/tools/fetch/ryhti` rather than in an `sdk/` root the workspace does
 * not declare.
 *
 * Three measured properties of the host decide what this module does. Measured on 2026-10-02:
 *
 * 1. **The host honors `Range`.** It answers `accept-ranges: bytes`, so an interrupted transfer
 *    resumes through {@linkcode resumableDownload} rather than restarting. That matters for the
 *    `full` edition, whose `content-length` was 183,974,254.
 * 2. **An edition's length and modification time are both served by `HEAD`.** `full.jsonl.gz`
 *    answered `last-modified` `Sat, 19 Sep 2026 03:30:49 GMT` and `2025.jsonl.gz` answered `Sat, 19
 *    Sep 2026 03:31:23 GMT` with `content-length` 3,963,957. The re-run check compares the pair
 *    against the manifest, which costs one small request per edition instead of the body.
 * 3. **This module moves bytes and decodes none of them.** The compressed body is streamed to disk
 *    and then decompressed stream to stream, so no chunk boundary is interpreted as a character
 *    boundary. ANAC's data carries accented Italian place names, and a `chunk.toString("utf8")` per
 *    gzip chunk writes U+FFFD at every boundary that splits a multi-byte character.
 *
 * ANAC updates the publication monthly, on the second of the month, which is why the current year's
 * edition is re-fetched on a `HEAD` disagreement rather than treated as final.
 *
 * The registry publishes this release under CC BY 4.0, which the address-source register elected.
 * The manifest records the licence and the attribution, and the adapter records the licence on every
 * row.
 */

import { APIClient } from "@mailwoman/core/api"
import { gunzipChunks } from "@mailwoman/core/fs/compression"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { openReadStream, openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { IT_ANAC_ADAPTER_ID, IT_ANAC_ATTRIBUTION, IT_ANAC_LICENSE } from "#it/adapters/anac/adapter"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { loadCollectionFiles, resumableDownload, writeManifest } from "#tools/fetch/download"

/**
 * The publication the registry serves this release under.
 *
 * Italy has four publications on the registry and id 117 is ANAC's.
 * Id 87 is OpenTender's Italian publication.
 *
 * It runs to March 2024 and comes from a different body.
 * Reading the country alone would take the wrong publication.
 */
export const IT_ANAC_PUBLICATION_ID = 117

/**
 * The download endpoint for one edition.
 */
export function anacEditionURL(edition: string): string {
	return `https://data.open-contracting.org/en/publication/${IT_ANAC_PUBLICATION_ID}/download?name=${edition}.jsonl.gz`
}

/**
 * The directory the editions are written under, which is the adapter's `inputPath`.
 */
const SLUG = IT_ANAC_ADAPTER_ID

/**
 * The edition fetched when a caller names none.
 *
 * `full` is every year in one file, which is what a corpus build reads.
 * A caller measuring one year names that year instead.
 */
export const IT_ANAC_DEFAULT_EDITIONS: readonly string[] = ["full"]

/**
 * What the manifest records per edition.
 *
 * {@linkcode SourceManifest}'s five fields describe the decompressed `.jsonl`,
 * which is what the adapter reads and what the digest covers.
 * The two added fields describe the transfer and are what the re-run check compares
 * before it downloads the body again.
 */
export interface ANACEditionManifest extends SourceManifest {
	/**
	 * The `last-modified` the host served the compressed edition under, or `null` where it served none.
	 */
	last_modified: string | null
	/**
	 * The `content-length` the host stated for the compressed edition, or `null` where it stated none.
	 */
	compressed_bytes: number | null
}

/**
 * What the host states about one edition without sending it.
 */
export interface ANACEditionHead {
	lastModified: string | null
	contentLength: number | null
	contentType: string | null
}

/**
 * Read what the host states about one edition.
 *
 * Through `APIClient`, which is the interface for a repeated request with a small response.
 * The bodies are not taken this way: `APIClient` buffers a response, and the `full` edition is 184 MB.
 *
 * A header the host does not send is reported as `null` rather than raised on,
 * and the caller then downloads rather than reading the absence as a match.
 */
export async function readANACEditionHead(client: Pick<APIClient, "fetch">, edition: string): Promise<ANACEditionHead> {
	const response = await client.fetch<unknown>({ method: "head", url: anacEditionURL(edition) })
	const headers = response.headers as Record<string, string> | undefined
	const length = headers?.["content-length"]

	return {
		lastModified: headers?.["last-modified"] ?? null,
		contentLength: length !== undefined && /^\d+$/u.test(length) ? Number(length) : null,
		contentType: headers?.["content-type"] ?? null,
	}
}

export interface DownloadANACOptions {
	/**
	 * Where the editions and the manifest are written.
	 * The directory itself is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Which editions to fetch: a year, `undated`, or `full`.
	 * Defaults to {@linkcode IT_ANAC_DEFAULT_EDITIONS}.
	 */
	editions?: readonly string[]
	/**
	 * Keep the compressed copy beside the `.jsonl`.
	 *
	 * The adapter reads the `.jsonl`, so the default removes the archive once it is written.
	 */
	keepCompressed?: boolean
	/**
	 * Re-read the `.jsonl`'s sha256 on a re-run instead of comparing its byte count.
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
	signal?: AbortSignal
	report?: (line: string) => void
}

export type FetchITANACOptions = BaseFetchOptions & Omit<DownloadANACOptions, "outputDir" | "report">

/**
 * The directory `#it/adapters/anac/adapter` reads under a fetch root.
 *
 * The adapter takes the directory rather than one file, because a build reading
 * several years reads every edition in it.
 */
export function itANACInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)
}

/**
 * Whether an edition on disk is still the one the manifest describes and the host still serves.
 *
 * The `HEAD` decides first, because ANAC republishes the publication monthly
 * and the host states a new length and modification time when it does.
 * The file's own length is then checked, so a truncated local copy is re-fetched even
 * where the host has not changed.
 *
 * Exported so a test can exercise the decision without a transfer: the alternative is
 * letting {@linkcode downloadITANAC} reach the host to find out which branch it took.
 */
export async function isANACEditionCurrent(
	recorded: ANACEditionManifest | undefined,
	head: ANACEditionHead,
	path: PathBuilderLike,
	verifyDigest: boolean
): Promise<boolean> {
	if (!recorded) return false

	// A host that states neither cannot be compared against, so the edition is downloaded.
	if (head.lastModified === null && head.contentLength === null) return false

	if (head.lastModified !== null && head.lastModified !== recorded.last_modified) return false

	if (head.contentLength !== null && head.contentLength !== recorded.compressed_bytes) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	if (!verifyDigest) return true

	return (await sha256File(path)) === recorded.sha256
}

/**
 * Download each requested edition into `options.outputDir` and leave them beside one manifest.
 *
 * Re-runnable per edition: an edition whose `HEAD` matches the manifest's recorded
 * modification time and compressed length, and whose `.jsonl` is still on disk at
 * the recorded length, makes no request for the body.
 */
export async function downloadITANAC(
	client: Pick<APIClient, "fetch">,
	options: DownloadANACOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const editions = options.editions?.length ? options.editions : IT_ANAC_DEFAULT_EDITIONS

	await makeDirectories(destDir)

	const manifestPath = destDir("MANIFEST.json")
	const recorded = (await loadCollectionFiles(manifestPath)) as Map<string, ANACEditionManifest>
	const written = new Map<string, ANACEditionManifest>(recorded)
	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	report?.(`=== ${SLUG}`)

	for (const edition of editions) {
		const filename = `${edition}.jsonl`
		const editionPath = destDir(filename)
		const compressedPath = destDir(`${filename}.gz`)

		let head: ANACEditionHead

		try {
			head = await readANACEditionHead(client, edition)
		} catch (error) {
			report?.(`  ✗ ${edition}: ${error instanceof Error ? error.message : String(error)}`)

			summary.failed++
			summary.failedCodes.push(edition)

			continue
		}

		report?.(
			`  ${edition}: ${head.contentLength === null ? "no content-length" : `${ByteFormatter.formatIEC(head.contentLength)} compressed`}` +
				`, last-modified ${head.lastModified ?? "absent"}`
		)

		const current =
			!options.force &&
			(await isANACEditionCurrent(recorded.get(filename), head, editionPath, options.verifyDigest ?? false))

		if (current) {
			report?.(`  ✓ ${edition} already current — no download.`)

			summary.skipped++

			continue
		}

		let compressedBytes: number

		try {
			compressedBytes = await resumableDownload({
				url: anacEditionURL(edition),
				dest: compressedPath,
				headers: { accept: "application/gzip, application/x-gzip, */*" },
				retryDelayMs: options.retryDelayMs,
				report,
			})
		} catch (error) {
			report?.(`  ✗ ${edition} download failed: ${error instanceof Error ? error.message : String(error)}`)
			await removePathIfPresent(compressedPath)

			summary.failed++
			summary.failedCodes.push(edition)

			continue
		}

		// The delivered count rather than the stated one.
		// ANAC republishes monthly, so a `HEAD` taken before the transfer can describe
		// a different edition than the body that arrived.
		if (head.contentLength !== null && head.contentLength !== compressedBytes) {
			report?.(
				`  ! ${edition}: the HEAD stated ${head.contentLength} compressed bytes and ${compressedBytes} arrived, ` +
					`so the edition was republished between the two requests`
			)
		}

		try {
			await decompressToJSONL(compressedPath, editionPath)
		} catch (error) {
			report?.(`  ✗ ${edition} decompress failed: ${error instanceof Error ? error.message : String(error)}`)
			await removePathIfPresent(compressedPath)

			summary.failed++
			summary.failedCodes.push(edition)

			continue
		}

		const stat = await tryStat(editionPath)

		if (!stat) {
			report?.(`  ✗ ${edition}: the decompressed edition is not at ${editionPath.toString()}`)

			summary.failed++
			summary.failedCodes.push(edition)

			continue
		}

		if (!options.keepCompressed) {
			await removePathIfPresent(compressedPath)
		}

		written.set(filename, {
			source_url: anacEditionURL(edition),
			downloaded_at: new Date().toISOString(),
			filename,
			sha256: await sha256File(editionPath),
			bytes: stat.size,
			last_modified: head.lastModified,
			compressed_bytes: compressedBytes,
		})

		report?.(`  ✓ ${edition}: ${ByteFormatter.formatIEC(stat.size)} decompressed`)

		summary.fetched++
	}

	const manifest: SourceCollectionManifest = {
		source: SLUG,
		source_url: `https://data.open-contracting.org/en/publication/${IT_ANAC_PUBLICATION_ID}`,
		license: IT_ANAC_LICENSE,
		attribution: IT_ANAC_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
		files: [...written.values()].toSorted((left, right) => left.filename.localeCompare(right.filename)),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  MANIFEST written to ${manifestPath.toString()}`)

	return summary
}

/**
 * Download ANAC's OCDS editions into `<outRoot>/it-anac/`.
 *
 * The registry entry point.
 * `#it/adapters/anac/adapter` is pointed at {@linkcode itANACInputPath},
 * the directory itself, so it reads every edition inside it.
 */
export async function fetchITANAC(options: FetchITANACOptions, report?: (line: string) => void): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadITANAC(client, {
		outputDir: options.outRoot(SLUG),
		editions: options.editions,
		keepCompressed: options.keepCompressed,
		verifyDigest: options.verifyDigest,
		force: options.force,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}

/**
 * Decompress one gzip file to another path, stream to stream.
 *
 * Exported because a test exercises it directly: an accented Italian place name
 * split across two gzip chunks must arrive whole.
 */
export async function decompressToJSONL(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const decompressed = gunzipChunks(openReadStream(source))

	await pipeline(Readable.fromWeb(decompressed as Parameters<typeof Readable.fromWeb>[0]), openWriteStream(destination))
}
