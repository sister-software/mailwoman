/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
import { streamToDisk } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Points to the Web Soil Survey download cache that serves survey-area archives.
 */
export const WSS_SSA_CACHE_URL = "https://websoilsurvey.sc.egov.usda.gov/DSD/Download/Cache/SSA"

/**
 * Returns the archive URL for one survey area at one version date, with the brackets
 * around the date percent-encoded because they are not valid in a URL path.
 */
export function surveyAreaArchiveURL(areaSymbol: string, versionDate: string): string {
	return `${WSS_SSA_CACHE_URL}/wss_SSA_${areaSymbol}_%5B${versionDate}%5D.zip`
}

/**
 * Configures {@link downloadSurveyArea}, which caches the archive and its
 * extracted tree under `cacheRoot/<versionDate>`.
 */
export interface DownloadSurveyAreaOptions {
	areaSymbol: string

	/**
	 * The survey area's version date from `sacatalog.saverest`, formatted as `YYYY-MM-DD`.
	 */
	versionDate: string

	/**
	 * The cache directory, where each version date gets its own subdirectory so a new
	 * vintage never overwrites an old one and a repeat run downloads nothing.
	 */
	cacheRoot: PathBuilderLike
	onProgress?: (message: string) => void
}

const PROGRESS_STRIDE_BYTES = 8 * 1024 * 1024

const UNKNOWN_VERSION_STATUS = 400

/**
 * What one acquired survey area is, on disk.
 */
export interface SurveyAreaArchive {
	areaSymbol: string
	versionDate: string

	/**
	 * The extracted `<areasymbol>/` directory, which holds `spatial/` and `tabular/`.
	 */
	root: PathBuilder
	spatialDirectory: PathBuilder
	tabularDirectory: PathBuilder

	/**
	 * The downloaded ZIP archive, kept so a repeat run skips the transfer and the bytes can be rechecked.
	 */
	archivePath: PathBuilder
}

/**
 * Downloads and unzips one survey area into the cache, skipping steps already done,
 * and returns where its pieces are.
 *
 * The download goes through a `.part` file, so an interrupted transfer never looks like a complete archive.
 *
 * @throws {Error} When the host answers anything but 200, or when the extracted
 * tree lacks the `spatial` or `tabular` directory.
 */
export async function downloadSurveyArea(options: DownloadSurveyAreaOptions): Promise<SurveyAreaArchive> {
	const vintageDirectory = PathBuilder.from(options.cacheRoot)(options.versionDate)
	const root = vintageDirectory(options.areaSymbol)
	const archivePath = vintageDirectory(`wss_SSA_${options.areaSymbol}.zip`)

	if (!(await tryStat(root))) {
		await makeDirectories(vintageDirectory)

		if (await tryStat(archivePath)) {
			options.onProgress?.(`${options.areaSymbol}: archive for ${options.versionDate} already downloaded`)
		} else {
			await streamToDisk({
				url: surveyAreaArchiveURL(options.areaSymbol, options.versionDate),
				destination: archivePath,
				context: "soil download",
				progressStrideBytes: PROGRESS_STRIDE_BYTES,
				describeStatus: (status) =>
					status === UNKNOWN_VERSION_STATUS
						? " — this host answers 400 rather than 404 for a version date it does not hold, so check the date against sacatalog.saverest"
						: undefined,

				...(options.onProgress
					? { onProgress: (message: string) => options.onProgress?.(`${options.areaSymbol}: ${message}`) }
					: {}),
			})
		}

		await runFile("unzip", ["-o", "-q", archivePath, "-d", vintageDirectory])
	} else {
		options.onProgress?.(`${options.areaSymbol}: already extracted for ${options.versionDate}`)
	}

	const spatialDirectory = root("spatial")
	const tabularDirectory = root("tabular")

	for (const directory of [spatialDirectory, tabularDirectory]) {
		if (!(await tryStat(directory))) {
			throw new Error(
				`soil download: ${options.areaSymbol} extracted without a ${directory} directory — every survey area publishes both spatial/ and tabular/, so this archive is not the product`
			)
		}
	}

	return {
		areaSymbol: options.areaSymbol,
		versionDate: options.versionDate,
		root,
		spatialDirectory,
		tabularDirectory,
		archivePath,
	}
}
