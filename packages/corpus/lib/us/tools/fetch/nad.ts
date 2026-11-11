/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the US DOT National Address Database (NAD) release and write it to Parquet for the `usgov-nad` adapter.
 *   US Public Domain (17 U.S.C. § 105).
 *
 *   The release is one zip archive holding a delimited text file of every address point, about 99 million rows in
 *   release 24. The command downloads it to `<outRoot>/usgov-nad/bulk/nad.zip`, extracts the text, and writes
 *   `<member>.parquet` sorted by state and county beside the archive.
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

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntries, listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { ResumeRefusedError, streamToDisk } from "@mailwoman/core/utils"
import { type PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { readManifest, writeManifest } from "#tools/fetch/download"
import { convertNADToParquet, readCurrentNADParquetRecord } from "#us/tools/fetch/nad/parquet"

const SLUG = "usgov-nad"

/**
 * The download link DOT's open-data portal serves for the current NAD release.
 */
export const NAD_RELEASE_URL = "https://data.transportation.gov/download/fc2s-wawr/application%2Fx-zip-compressed"

export interface FetchNADOptions extends BaseFetchOptions {
	/**
	 * The release archive's download link.
	 *
	 * @defaultValue {@linkcode NAD_RELEASE_URL}
	 */
	nadURL?: string
}

/**
 * The release Parquet file {@link fetchNAD} wrote under `sourcesRoot`,
 * such as `usgov-nad/bulk/TXT_NAD_r24.parquet`.
 *
 * @throws When the bulk directory holds no Parquet file or more than one, naming each one found.
 */
export async function nadReleaseParquetPath(sourcesRoot: PathBuilderLike): Promise<PathBuilder> {
	const bulkDir = resolvePathBuilder(sourcesRoot, SLUG, "bulk")

	const found = (await pathExists(bulkDir))
		? await Globerator.files("parquet", { cwd: bulkDir, absolute: false, recursive: false }).toSorted()
		: []

	if (found.length !== 1) {
		throw new Error(
			`${bulkDir} holds ${found.length} Parquet files (${found.join(", ") || "none"}); ` +
				`run \`mailwoman corpus fetch nad\` or pass the file`
		)
	}

	return bulkDir(found[0]!)
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

	const parquetPath = bulkDir(`${member.replace(/\.[^.]+$/u, "").replaceAll("/", "_")}.parquet`)
	const current = await readCurrentNADParquetRecord(parquetPath, sha256, member)

	if (current) {
		report?.(`  parquet current: ${current.rows.toLocaleString()} rows from ${member} in ${parquetPath}`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	const extractedDir = bulkDir("extracted")

	await extractZipEntries(archivePath, extractedDir, { selector: member, skipExisting: true })

	const { record } = await convertNADToParquet({
		textPath: extractedDir(member),
		parquetPath,
		sourceSHA256: sha256,
		member,
		report,
	})

	await removePathIfPresent(extractedDir)
	report?.(`  ✓ wrote ${parquetPath}: ${record.rows.toLocaleString()} rows; removed ${extractedDir}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
