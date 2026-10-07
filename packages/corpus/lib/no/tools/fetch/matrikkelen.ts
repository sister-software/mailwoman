/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads the `Matrikkelen - Adresse` CSV extracts Kartverket publishes through Geonorge.
 *
 *   ## Two areas, because the adapter emits two jurisdictions
 *
 *   `#no/adapters/matrikkelen/adapter` reads `kommunenummer` to decide a row's country, and
 *   municipality 2100 is Svalbard rather than the mainland. Geonorge publishes the dataset per area
 *   from one 375-entry area list, and the two entries this repository reads are `0000` `Hele landet`
 *   and `2100` `Svalbard`. The mainland extract has no Svalbard row, so taking only `0000` would
 *   leave `SJ` with no rows while the adapter still claimed to cover it.
 *
 *   Each area is a separate archive at the dataset's conventional download path, so no download
 *   order has to be placed through Geonorge's order API:
 *
 *       …/MatrikkelenAdresse/CSV/Basisdata_<area>_<name>_4258_MatrikkelenAdresse_CSV.zip
 *
 *   ## Why the member is extracted
 *
 *   The adapter opens `opts.inputPath` with `CSVSpliterator.fromAsync`. That reader takes a
 *   delimited file rather than an archive, so the member is written out beside the archive it came
 *   from. The member is `matrikkelenAdresse.csv` in every area's archive, inside a directory whose
 *   name follows the archive. Each area is written under its own area-code directory, and the
 *   publisher's own file name is kept.
 *
 *   The archive is kept rather than removed, because its sha256 is the value the address-source
 *   register records for the publication and the member's is not.
 *
 *   ## Freshness
 *
 *   Geonorge serves `last-modified` and `content-length` on the archive, and a regenerated extract
 *   changes both. A skip requires a stated `last-modified`: where the service states none, both
 *   sides read `null`, an equality test would hold, and an archive of unknown age would be kept for
 *   as long as the service stayed silent.
 *
 *   ## The header is checked on arrival
 *
 *   A renamed column reaches the adapter as an empty string on every row rather than as an error, so
 *   the extract's header is read through the same `CSVSpliterator` the adapter uses and checked
 *   against the nine columns the adapter indexes by name. The file's first column name has a
 *   byte-order mark, and none of the nine is that column, so the check does not depend on stripping
 *   the mark.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { extractZipEntry } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { MATRIKKELEN_ADAPTER_ID } from "#no/adapters/matrikkelen/adapter"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, loadCollectionFiles, writeManifest } from "#tools/fetch/download"
import { assertHeaderColumns, readDelimitedHeader } from "#tools/fetch/header"

/**
 * One area of the dataset, as Geonorge's own area list for it spells the two parts of its file name.
 */
export interface MatrikkelenArea {
	/**
	 * The area code. Each area is written under this directory.
	 */
	code: string
	/**
	 * The area name as the download path spells it. That name differs from the list's `name`:
	 * the list calls area `0000` `Hele landet`, and the path calls it `Norge`.
	 */
	pathName: string
}

/**
 * The areas a fetch takes when a caller gives no codes.
 *
 * `0000` is the mainland and `2100` is Svalbard. These are the two areas the address-source
 * register holds rows for. Svalbard is also published as `fylke` 21. That area holds the same rows
 * as kommune 2100.
 */
export const MATRIKKELEN_AREAS: readonly MatrikkelenArea[] = [
	{ code: "0000", pathName: "Norge" },
	{ code: "2100", pathName: "Svalbard" },
]

/**
 * The area code of the whole-country extract. That extract holds every mainland municipality.
 */
export const MATRIKKELEN_MAINLAND_AREA = "0000"

/**
 * The projection the CSV extracts are taken in.
 *
 * EPSG:4258 is the geographic projection, and it is the one the register measured.
 * The same extract is published in EPSG:25833 and differs only in its coordinates.
 */
export const MATRIKKELEN_PROJECTION = "4258"

/**
 * The directory the dataset's per-area archives sit in.
 */
export const MATRIKKELEN_DOWNLOAD_ROOT = "https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenAdresse/CSV"

/**
 * The dataset's metadata record. That record states the elected license.
 */
export const MATRIKKELEN_METADATA_URL =
	"https://kartkatalog.geonorge.no/api/getdata/f7df7a18-b30f-4745-bd64-d0863812350c"

/**
 * The name of the member inside every area's archive, and of the file the adapter reads.
 */
export const MATRIKKELEN_MEMBER_FILENAME = "matrikkelenAdresse.csv"

/**
 * The column delimiter the publisher writes.
 */
export const MATRIKKELEN_DELIMITER = ";"

/**
 * The columns `#no/adapters/matrikkelen/adapter` reads by name.
 *
 * Checked against the extract's header on arrival, because a renamed column reaches
 * the adapter as an empty string on every row rather than as an error.
 */
export const MATRIKKELEN_REQUIRED_COLUMNS: readonly string[] = [
	"kommunenummer",
	"adressetype",
	"adressenavn",
	"nummer",
	"bokstav",
	"adresseTekst",
	"postnummer",
	"poststed",
	"adresseId",
]

/**
 * The attribution CC BY 4.0 §3(a)(1) requires on a publication derived from these rows.
 */
export const MATRIKKELEN_ATTRIBUTION = "Kartverket"

/**
 * The license the address-source register elected for this publisher.
 *
 * Kartverket's metadata record states CC BY 4.0 across five agreeing fields,
 * and the adapter stamps the same identifier on every row.
 */
export const MATRIKKELEN_LICENSE = "CC-BY-4.0"

const SLUG = MATRIKKELEN_ADAPTER_ID

/**
 * The archive's name for one area. The fetch writes the archive under this name.
 */
export function matrikkelenArchiveFilename(area: MatrikkelenArea): string {
	return `Basisdata_${area.code}_${area.pathName}_${MATRIKKELEN_PROJECTION}_MatrikkelenAdresse_CSV.zip`
}

/**
 * The archive's URL for one area.
 */
export function matrikkelenArchiveURL(area: MatrikkelenArea): string {
	return `${MATRIKKELEN_DOWNLOAD_ROOT}/${matrikkelenArchiveFilename(area)}`
}

/**
 * What one area's run recorded.
 *
 * `last_modified` is the service's own header and the one freshness signal it offers,
 * so a changed value is the one reason to download that area again.
 * `bytes` and `sha256` describe the archive. The address-source register records a digest for
 * that artifact.
 */
export interface MatrikkelenFileManifest extends SourceManifest {
	area_code: string
	last_modified: string | null
	member_filename: string
	member_bytes: number
	member_sha256: string
}

/**
 * The recorded entry for one area, or `undefined` where the manifest holds none that can decide a skip.
 *
 * `loadCollectionFiles` reads the shared collection shape. That shape states the fields common to
 * every source's manifest and omits this source's area fields.
 * An entry written before those fields existed, or written with no stated `last_modified`,
 * cannot answer whether the archive on disk is current, and this reports that as
 * no recorded entry rather than as an entry that disagrees.
 */
export function recordedMatrikkelenArea(entry: SourceManifest | undefined): MatrikkelenFileManifest | undefined {
	const candidate = entry as (Partial<MatrikkelenFileManifest> & SourceManifest) | undefined

	if (!candidate) return undefined

	const complete =
		typeof candidate.area_code === "string" &&
		typeof candidate.last_modified === "string" &&
		typeof candidate.member_filename === "string" &&
		typeof candidate.member_bytes === "number" &&
		typeof candidate.member_sha256 === "string"

	return complete ? (candidate as MatrikkelenFileManifest) : undefined
}

/**
 * What the service's HEAD response states about one area's archive.
 *
 * Both fields read `null` where the header is absent, rather than an empty string or zero.
 * An absent `last-modified` is the service declining to state a version. That differs from a
 * version that matches the one on disk.
 */
export interface MatrikkelenPublication {
	lastModified: string | null
	reportedBytes: number | null
}

/**
 * Reads the service's HEAD response for one area.
 *
 * Separate from {@linkcode downloadMatrikkelen}: this request supplies the whole freshness
 * decision. The download itself runs on global `fetch`, so a unit test cannot intercept it.
 */
export async function readMatrikkelenPublication(
	client: Pick<APIClient, "fetch">,
	area: MatrikkelenArea,
	options: { signal?: AbortSignal } = {}
): Promise<MatrikkelenPublication> {
	const head = await client.fetch<unknown>({
		method: "HEAD",
		url: matrikkelenArchiveURL(area),
		timeout: 120_000,
		signal: options.signal,
	})

	const reported = Number(head.headers?.["content-length"] ?? Number.NaN)

	return {
		lastModified: String(head.headers?.["last-modified"] ?? "") || null,
		reportedBytes: Number.isFinite(reported) ? reported : null,
	}
}

/**
 * Whether one area's archive and extract on disk are the ones the service currently serves.
 *
 * A skip requires the service to state a `last-modified` value.
 * Where it states none, both sides read `null` and an equality test would hold. That would keep an
 * archive of unknown age for as long as the service stayed silent.
 */
export function matrikkelenPublicationIsRecorded(
	recorded: MatrikkelenFileManifest,
	bytesOnDisk: number,
	memberBytesOnDisk: number,
	publication: MatrikkelenPublication
): boolean {
	if (publication.lastModified === null) return false

	return (
		recorded.last_modified === publication.lastModified &&
		recorded.bytes === bytesOnDisk &&
		recorded.member_bytes === memberBytesOnDisk
	)
}

/**
 * The areas for the given codes, or every area in {@linkcode MATRIKKELEN_AREAS}.
 *
 * @throws When the area list holds no matching area, the error states the unmatched codes. A
 * typed code then reports itself rather than reading as a fetch of no areas.
 */
export function matrikkelenAreasFor(codes: readonly string[] | undefined): readonly MatrikkelenArea[] {
	if (!codes?.length) return MATRIKKELEN_AREAS

	const wanted = codes.map((code) => code.trim()).filter((code) => code.length > 0)
	const absent = wanted.filter((code) => !MATRIKKELEN_AREAS.some((area) => area.code === code))

	if (absent.length) {
		throw new Error(
			`${SLUG}: ${absent.join(", ")} is not an area this fetcher carries a download path for — it carries ${MATRIKKELEN_AREAS.map((area) => area.code).join(", ")}`
		)
	}

	return MATRIKKELEN_AREAS.filter((area) => wanted.includes(area.code))
}

/**
 * Per-invocation options.
 */
export interface DownloadMatrikkelenOptions {
	outputDir: PathBuilderLike
	/**
	 * The areas to take, defaulting to {@linkcode MATRIKKELEN_AREAS}.
	 */
	areas?: readonly MatrikkelenArea[]
	/**
	 * Downloads each area even where the manifest's `last_modified` and byte counts still match.
	 */
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Downloads one area's archive, extracts the member the adapter reads and checks its header.
 *
 * @returns The manifest entry for the area. The collection manifest holds it.
 */
export async function downloadMatrikkelenArea(
	client: Pick<APIClient, "fetch">,
	area: MatrikkelenArea,
	options: {
		outputDir: PathBuilderLike
		recorded?: MatrikkelenFileManifest
		force?: boolean
		retries?: number
		retryDelayMs?: number
		signal?: AbortSignal
		report?: (line: string) => void
	}
): Promise<{ entry: MatrikkelenFileManifest; downloaded: boolean }> {
	const { report } = options
	const archiveFilename = matrikkelenArchiveFilename(area)
	const areaDir = PathBuilder.from(options.outputDir)(area.code)
	const archivePath = areaDir(archiveFilename)
	const memberPath = areaDir(MATRIKKELEN_MEMBER_FILENAME)

	report?.(`=== ${SLUG} / ${archiveFilename}`)

	const publication = await readMatrikkelenPublication(client, area, { signal: options.signal })

	report?.(
		`  HEAD: ${publication.reportedBytes === null ? "no content-length" : ByteFormatter.formatIEC(publication.reportedBytes)}` +
			`, last-modified ${publication.lastModified ?? "unstated"}`
	)

	await makeDirectories(areaDir)

	const archiveStat = await tryStat(archivePath)
	const memberStat = await tryStat(memberPath)

	if (
		!options.force &&
		options.recorded &&
		archiveStat &&
		memberStat &&
		matrikkelenPublicationIsRecorded(options.recorded, archiveStat.size, memberStat.size, publication)
	) {
		report?.(`  present, and the service's last-modified is unchanged`)

		return { entry: options.recorded, downloaded: false }
	}

	const { bytes } = await downloadToFile({
		url: matrikkelenArchiveURL(area),
		dest: archivePath,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		report,
	})

	const sha256 = await sha256File(archivePath)

	report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	// The member sits inside a directory whose name follows the archive, so the selector matches
	// the name's tail rather than the whole archive-internal path.
	const memberBytes = await extractZipEntry(archivePath, /(?:^|\/)matrikkelenAdresse\.csv$/u, memberPath)

	const header = await readDelimitedHeader(memberPath, MATRIKKELEN_DELIMITER)

	assertHeaderColumns(header, MATRIKKELEN_REQUIRED_COLUMNS, `${SLUG} ${area.code} ${MATRIKKELEN_MEMBER_FILENAME}`)

	const memberSHA256 = await sha256File(memberPath)

	report?.(
		`  ${MATRIKKELEN_MEMBER_FILENAME}: ${ByteFormatter.formatIEC(memberBytes)} over ${header.length} columns  sha256=${memberSHA256}`
	)

	return {
		entry: {
			source_url: matrikkelenArchiveURL(area),
			filename: archiveFilename,
			area_code: area.code,
			bytes,
			sha256,
			last_modified: publication.lastModified,
			member_filename: MATRIKKELEN_MEMBER_FILENAME,
			member_bytes: memberBytes,
			member_sha256: memberSHA256,
			downloaded_at: new Date().toISOString(),
		},
		downloaded: true,
	}
}

/**
 * Downloads every requested area and writes the collection manifest beside them.
 *
 * An area that fails is counted and the rest are still taken, because the two areas are
 * separate publications and Svalbard's 57 KiB does not depend on the mainland's 145 MiB.
 */
export async function downloadMatrikkelen(
	client: Pick<APIClient, "fetch">,
	options: DownloadMatrikkelenOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const manifestPath = destDir("MANIFEST.json")
	const areas = options.areas ?? MATRIKKELEN_AREAS

	await makeDirectories(destDir)

	const entries = await loadCollectionFiles(manifestPath)

	let fetched = 0
	let skipped = 0
	const failedCodes: string[] = []

	for (const area of areas) {
		if (options.signal?.aborted) break

		try {
			const { entry, downloaded } = await downloadMatrikkelenArea(client, area, {
				outputDir: destDir,
				recorded: recordedMatrikkelenArea(entries.get(matrikkelenArchiveFilename(area))),
				force: options.force,
				retries: options.retries,
				retryDelayMs: options.retryDelayMs,
				signal: options.signal,
				report,
			})

			entries.set(entry.filename, entry)

			if (downloaded) {
				fetched += 1
			} else {
				skipped += 1
			}
		} catch (error) {
			report?.(`  ✗ ${area.code}: ${error instanceof Error ? error.message : String(error)}`)

			failedCodes.push(area.code)
		}
	}

	const manifest: SourceCollectionManifest = {
		source: SLUG,
		source_url: MATRIKKELEN_METADATA_URL,
		license: MATRIKKELEN_LICENSE,
		attribution: MATRIKKELEN_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
		// Sorted by area code, so the manifest's order is the area list's rather than the run's.
		files: [...entries.values()].toSorted((left, right) => left.filename.localeCompare(right.filename)),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}

/**
 * The path `#no/adapters/matrikkelen/adapter` reads for one area, given the root a fetch wrote under.
 *
 * The area is a parameter because the adapter covers two jurisdictions and reads one
 * file at a time: `0000` holds Norway's rows and `2100` holds Svalbard's.
 */
export function matrikkelenInputPath(
	outRoot: BaseFetchOptions["outRoot"],
	areaCode: string = MATRIKKELEN_MAINLAND_AREA
): PathBuilderLike {
	return outRoot(SLUG, areaCode, MATRIKKELEN_MEMBER_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchMatrikkelenOptions extends BaseFetchOptions {
	/**
	 * Geonorge area codes, defaulting to every area in {@linkcode MATRIKKELEN_AREAS}.
	 */
	areas?: readonly string[]
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchMatrikkelen(
	options: FetchMatrikkelenOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const areas = matrikkelenAreasFor(options.areas)

	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadMatrikkelen(client, {
		outputDir: options.outRoot(SLUG),
		areas,
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}
