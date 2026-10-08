/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire one region's archive of Building Digital UK's UPRN-level release and extract its CSV files.
 *
 *   GOV.UK publishes each region as one ZIP attachment of the release's publication page. The page's
 *   content item, `https://www.gov.uk/api/content/<page path>`, lists each attachment's URL and byte size.
 *   The URL holds an opaque media identifier, so the caller reads it from the content item rather than
 *   assembling it, and passes the stated size so that a short or altered transfer throws.
 *
 *   The archive is stored as published under `<root>/<release>/<region>/`, and its SHA-256 is computed in
 *   the pass that writes it. An archive already on disk is reused and hashed again, so every report states
 *   the bytes on disk. `streamToDisk` documents why the transfer uses `fetch` rather than `APIClient`.
 */

import { readFileSize, tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { createHash, sha256File } from "@mailwoman/core/hash"
import { streamToDisk } from "@mailwoman/core/utils"
import { basename, PathBuilder, type PathBuilderLike } from "path-ts"

import { BDUK_EXTRACTED_DIRECTORY, bdukReleasePath } from "#paths"

/**
 * The attachment to download and where its region's files go.
 */
export interface DownloadBDUKRegionOptions {
	/**
	 * The attachment's URL on `assets.publishing.service.gov.uk`, from the publication's content item.
	 */
	url: string
	/**
	 * The attachment's `file_size` from the content item.
	 */
	expectedBytes: number
	/**
	 * The OMR month the release covers, as `YYYY-MM`, and the name of the release's directory.
	 */
	release: string
	/**
	 * The region's directory name, such as `london`.
	 */
	region: string
	/**
	 * The directory that holds one directory per release.
	 *
	 * @default `$MAILWOMAN_DATA_ROOT/bduk`
	 */
	root?: PathBuilderLike
	onProgress?: (message: string) => void
}

/**
 * What a download stored, with the archive's size and digest.
 */
export interface BDUKRegionDownload {
	readonly url: string
	/**
	 * The archive as published.
	 */
	readonly archive: string
	readonly bytes: number
	readonly sha256: string
	/**
	 * Whether this call transferred the archive.
	 *
	 * It is `false` when the call reused an archive already on disk.
	 */
	readonly transferred: boolean
	/**
	 * The directory that holds the extracted CSV files.
	 */
	readonly extracted: string
	/**
	 * The extracted CSV file names, in archive order.
	 */
	readonly files: readonly string[]
}

/**
 * Downloads one region's archive, unless it is already on disk, and extracts its CSV files.
 *
 * Every CSV member lands directly in the extracted directory under its own name,
 * where `readBDUKReleaseDirectory` reads it.
 *
 * @throws When the response is not OK, the archive's size differs from `expectedBytes`,
 * the archive holds no CSV file, or two CSV members share a name.
 */
export async function downloadBDUKRegion(options: DownloadBDUKRegionOptions): Promise<BDUKRegionDownload> {
	const regionDirectory = PathBuilder.from(options.root ?? bdukReleasePath)(options.release, options.region)
	const archive = regionDirectory(basename(new URL(options.url).pathname))
	const transferred = !(await tryStat(archive))
	let bytes: number
	let sha256: string

	await makeDirectories(regionDirectory)

	if (transferred) {
		const hash = createHash("sha256")

		bytes = await streamToDisk({
			url: options.url,
			destination: archive,
			context: "bduk download",
			onChunk: (chunk) => hash.update(chunk),
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		})

		sha256 = hash.digest("hex")
	} else {
		options.onProgress?.(`reusing ${archive.toString()}`)

		bytes = await readFileSize(archive)
		sha256 = await sha256File(archive)
	}

	if (bytes !== options.expectedBytes) {
		if (transferred) {
			await removePath(archive)
		}

		throw new Error(
			`bduk download: ${options.url} gave ${bytes} bytes where the content item states ${options.expectedBytes}` +
				(transferred ? "; the archive was removed." : `; remove ${archive.toString()} to download it again.`)
		)
	}

	const extracted = regionDirectory(BDUK_EXTRACTED_DIRECTORY)

	options.onProgress?.(`extracting ${archive.toString()}`)

	await makeDirectories(extracted)

	const members = await extractZipEntries(archive, extracted, {
		selector: /\.csv$/u,
		flatten: true,
		skipExisting: true,
	})

	const files = members.map((member) => basename(member))

	if (!files.length) throw new Error(`bduk download: ${archive.toString()} holds no CSV file.`)

	if (new Set(files).size !== files.length) {
		throw new Error(`bduk download: ${archive.toString()} holds two CSV members with one name: ${members.join(", ")}.`)
	}

	return {
		url: options.url,
		archive: archive.toString(),
		bytes,
		sha256,
		transferred,
		extracted: extracted.toString(),
		files,
	}
}
