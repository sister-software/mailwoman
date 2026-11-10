/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the US DOT National Address Database (NAD) release and write it to Parquet for the `usgov-nad` adapter.
 *   US Public Domain (17 U.S.C. § 105).
 *
 *   The release is one zip archive holding a delimited text file of every address point, about 99 million rows in
 *   release 24. DOT serves it at an undated link, so the archive is a current download at
 *   `$MAILWOMAN_CACHE_ROOT/sources/usgov-nad/bulk/nad.zip`. The command extracts the text and writes
 *   `<member>.parquet`, sorted by state and county, into the release's snapshot,
 *   `$MAILWOMAN_DATA_ROOT/snapshots/usgov-nad/<release>/`, where `<release>` is the `r24` the member's name states.
 *
 *   ## Usage
 *
 *   ```sh
 *   mailwoman corpus fetch nad
 *
 *   # A release published at another link
 *   mailwoman corpus fetch nad --nad-url <link>
 *   ```
 */

import { snapshotSourceDirectory } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntries, listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { ResumeRefusedError, streamToDisk } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { readManifest, writeManifest } from "#tools/fetch/download"
import { fetchSnapshot, type SnapshotFetchOptions, snapshotVintagePath } from "#tools/fetch/storage"
import { convertNADToParquet, readCurrentNADParquetRecord } from "#us/tools/fetch/nad/parquet"

const SLUG = "usgov-nad"

/**
 * The download link DOT's open-data portal serves for the current NAD release.
 */
export const NAD_RELEASE_URL = "https://data.transportation.gov/download/fc2s-wawr/application%2Fx-zip-compressed"

/**
 * The archive is a current download under `outRoot`, and each release's Parquet
 * file a snapshot under `snapshots`.
 */
export interface FetchNADOptions extends BaseFetchOptions, Pick<SnapshotFetchOptions, "snapshots"> {
	/**
	 * The release archive's download link.
	 *
	 * @defaultValue {@linkcode NAD_RELEASE_URL}
	 */
	nadURL?: string
}

/**
 * The release a text member's name states, as the vintage: `TXT_NAD_r24.txt` is `r24`.
 *
 * @throws When the name states no `r<number>` release.
 */
export function nadReleaseVintage(member: string): string {
	const release = /_(r\d+)\.(?:txt|csv)$/iu.exec(member)?.[1]

	if (!release) throw new Error(`${SLUG}: the archive member ${member} states no r<number> release`)

	return release.toLowerCase()
}

/**
 * The newest release Parquet file {@link fetchNAD} wrote, such as
 * `usgov-nad/r24/TXT_NAD_r24.parquet` under the snapshot root.
 *
 * @param snapshotDirectory The directory holding the source's vintages.
 * @defaultValue `snapshotSourceDirectory("usgov-nad")`
 * @throws When no release vintage holds a Parquet file, or the newest holds
 * more than one, naming each one found.
 */
export async function nadReleaseParquetPath(
	snapshotDirectory: PathBuilderLike = snapshotSourceDirectory(SLUG)
): Promise<PathBuilder> {
	const root = PathBuilder.from(snapshotDirectory)

	const found = (await pathExists(root))
		? await Globerator.from("r*/*.parquet", { cwd: root, absolute: false }).toArray()
		: []

	const release = (entry: string) => Number(/^r(\d+)\//u.exec(entry)?.[1] ?? Number.NaN)
	const newest = Math.max(...found.map(release).filter(Number.isFinite))
	const inNewest = found.filter((entry) => release(entry) === newest).toSorted()

	if (inNewest.length !== 1) {
		throw new Error(
			`${root} holds ${inNewest.length} Parquet files in its newest release (${found.join(", ") || "none"}); ` +
				`run \`mailwoman corpus fetch nad\` or pass the file`
		)
	}

	return root(inNewest[0]!)
}

/**
 * The archive's file name on disk.
 * The download URL can name a media type rather than a file.
 */
const BULK_ARCHIVE = "nad.zip"

/**
 * The member the conversion reads: the release's one large delimited text file.
 */
const BULK_TEXT_MEMBER = /\.(?:txt|csv)$/iu

/**
 * Downloads the release archive, extracts its text, and converts it to Parquet sorted by state and county.
 *
 * Each step keeps its output when the step before it is unchanged.
 * An archive whose manifest records the same URL and whose hash still matches isn't downloaded again.
 *
 * A Parquet file whose record holds the archive's hash and member is kept,
 * and the text is then never extracted.
 *
 * The extracted text, 42 GB for release 24, is removed once its Parquet file is written.
 * An interrupted download resumes from its `.part` file when the host honors
 * byte ranges, and starts over when it doesn't.
 */
export async function fetchNAD(options: FetchNADOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const url = options.nadURL ?? NAD_RELEASE_URL
	const bulkDir = options.outRoot(SLUG, "bulk")
	const archivePath = bulkDir(BULK_ARCHIVE)
	const manifestPath = bulkDir("MANIFEST.json")

	await makeDirectories(bulkDir)
	report?.(`=== ${SLUG} / bulk`)

	const recorded = await readManifest<SourceManifest>(manifestPath)
	let sha256: string

	if (
		recorded?.source_url === url &&
		(await pathExists(archivePath)) &&
		(await sha256File(archivePath)) === recorded.sha256
	) {
		sha256 = recorded.sha256
		report?.(`  archive current: ${ByteFormatter.formatIEC(recorded.bytes)} sha256=${sha256}`)
	} else {
		const partialPath = `${archivePath}.part`
		const resumeFrom = (await tryStat(partialPath))?.size ?? 0

		const download = (from: number) =>
			streamToDisk({
				url,
				destination: archivePath,
				context: SLUG,
				partialPath,
				retainPartial: true,
				...(from ? { resumeFrom: from } : {}),
				onProgress: (line) => report?.(`  ${line}`),
			})

		const bytes = await download(resumeFrom).catch((error: unknown) => {
			if (!(error instanceof ResumeRefusedError)) throw error

			report?.(`  ${error.message}; downloading from the start`)

			return download(0)
		})

		sha256 = await sha256File(archivePath)

		await writeManifest(manifestPath, {
			source_url: url,
			downloaded_at: new Date().toISOString(),
			filename: BULK_ARCHIVE,
			sha256,
			bytes,
		} satisfies SourceManifest)

		report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)} sha256=${sha256}`)
	}

	const members = (await listZipEntries(archivePath)).map((entry) => entry.name)
	const member = members.find((name) => BULK_TEXT_MEMBER.test(name))

	if (!member) {
		throw new Error(`${SLUG}: the archive holds no delimited text file (members: ${members.join(", ")})`)
	}

	const parquetName = `${member.replace(/\.[^.]+$/u, "").replaceAll("/", "_")}.parquet`
	const vintage = nadReleaseVintage(member)
	const target = snapshotVintagePath(options.snapshots, SLUG, vintage)
	const current = await readCurrentNADParquetRecord(target(parquetName), sha256, member)

	// The release's Parquet file was converted from this same archive, so the fetch keeps it.
	// A caller who states the release and passes --force converts it again.
	if (current && !(options.snapshots.force && options.snapshots.vintage != null)) {
		report?.(`  parquet current: ${current.rows.toLocaleString()} rows from ${member} in ${target(parquetName)}`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	return fetchSnapshot(
		options.snapshots,
		SLUG,
		vintage,
		async (releaseDir) => {
			const extractedDir = bulkDir("extracted")

			await extractZipEntries(archivePath, extractedDir, { selector: member, skipExisting: true })

			const { record } = await convertNADToParquet({
				textPath: extractedDir(member),
				parquetPath: releaseDir(parquetName),
				sourceSHA256: sha256,
				member,
				report,
			})

			await removePathIfPresent(extractedDir)
			report?.(`  ✓ wrote ${parquetName}: ${record.rows.toLocaleString()} rows; removed ${extractedDir}`)

			return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
		},
		report
	)
}
