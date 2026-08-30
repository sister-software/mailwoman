/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire one survey area's published archive — 13 to 41 MB streamed to disk and unzipped.
 *
 *   THE TRANSFER ITSELF LIVES IN `@mailwoman/core/utils`, and `streamToDisk` carries why a file transfer of
 *   this size keeps raw `fetch` instead of going through `APIClient`, plus the `.part`-rename rule. What is
 *   soil's, and stays here, is the URL shape, the cache key, and the two facts below that the shared
 *   transfer is told rather than assumes: the progress stride and what a 400 means. The METADATA reads
 *   around this one do go through `APIClient` — see `client.ts`.
 *
 *   FRESHNESS IS `sacatalog.saverest`, NEVER A LENGTH PROBE, AND THE HOST LEAVES NO CHOICE. It answers `HEAD`
 *   with HTTP 405 (`allow: GET`) and IGNORES `Range`: a request with `Range: bytes=0-0` returned HTTP 200 and
 *   transferred the whole 27,598,377 bytes in 7.23 s. So "check the size first" starts a real download. The
 *   cache is keyed on the version date the tabular service reports instead, and a vintage already on disk is
 *   never re-fetched. The `Range` behaviour is PATH-SPECIFIC rather than host-wide — `/DataAvailability/`
 *   does answer 206 — so a client must probe per path rather than conclude from one.
 *
 *   THE FILENAME EMBEDS THE VERSION DATE AND A WRONG ONE IS AN HTTP 400. Not a 404: asking for a date the
 *   host does not hold reads as a malformed request rather than a missing file, which is why the date comes
 *   from the catalogue rather than from a guess. The square brackets must be sent literally, so the URL is
 *   built with them percent-encoded.
 *
 *   TWO CACHE VARIANTS EXIST AND THE BARE ONE IS WANTED. `wss_SSA_IA153_[2025-09-09].zip` is 25,474,922 bytes;
 *   `wss_SSA_IA153_soildb_IA_2003_[2025-09-09].zip` is 27,598,377 and differs only by an EMPTY Microsoft Access
 *   template container for a workflow this program does not use. Confirmed on a second area (`IA015`:
 *   38,981,269 against 41,104,724 bytes) and on a third that ships no template at all (`TX299`, 13,455,641
 *   bytes, 97 files, no `.mdb`).
 */

import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { streamToDisk } from "@mailwoman/core/utils"
import { execFile } from "@mailwoman/platform/child_process"
import { join } from "@mailwoman/platform/path"
import { promisify } from "@mailwoman/platform/util"

const execFileAsync = promisify(execFile)

/**
 * The download service's survey-area cache. Documented at `https://websoilsurvey.sc.egov.usda.gov/DSD/Download/help`,
 * which lists `GET /{CacheName}/{FileName}`.
 */
export const WSS_SSA_CACHE_URL = "https://websoilsurvey.sc.egov.usda.gov/DSD/Download/Cache/SSA"

/**
 * The archive URL for one survey area at one version date.
 *
 * The brackets are percent-encoded rather than sent raw: they are not valid in a URL path, and a client that sends them
 * literally depends on the fetcher tolerating them.
 */
export function surveyAreaArchiveURL(areaSymbol: string, versionDate: string): string {
	return `${WSS_SSA_CACHE_URL}/wss_SSA_${areaSymbol}_%5B${versionDate}%5D.zip`
}

export interface DownloadSurveyAreaOptions {
	areaSymbol: string
	/**
	 * The version date from `sacatalog.saverest`, as `YYYY-MM-DD`.
	 */
	versionDate: string
	/**
	 * Where vintages are kept. Each version date gets its own directory, so a new refresh never overwrites the old one in
	 * place and a re-run against the same vintage never re-transfers.
	 */
	cacheRoot: string
	onProgress?: (message: string) => void
}

/**
 * Bytes between progress reports. Smaller than the shared default because these archives are 13–41 MB, and the default
 * stride would leave the smallest of them reporting once.
 */
const PROGRESS_STRIDE_BYTES = 8 * 1024 * 1024

/**
 * What this host answers for a version date it does not hold. NOT a 404: it reads as a malformed request rather than a
 * missing file, which is why the message below says so and why the date comes from the catalogue rather than a guess.
 */
const UNKNOWN_VERSION_STATUS = 400

/**
 * What one acquired survey area is, on disk.
 */
export interface SurveyAreaArchive {
	areaSymbol: string
	versionDate: string
	/**
	 * The extracted `<areasymbol>/` directory, holding `spatial/` and `tabular/`.
	 */
	root: string
	spatialDirectory: string
	tabularDirectory: string
	/**
	 * The archive as transferred. Kept so a re-run costs nothing and so the bytes are re-checkable.
	 */
	archivePath: string
}

/**
 * Download and unzip one survey area, returning where its pieces landed.
 *
 * Downloads to a `.part` file and renames only on a clean finish, so an interrupted transfer never presents as a
 * complete archive — the same discipline the database build uses, for the same reason.
 *
 * @throws {Error} When the host answers anything but 200, or when the extracted tree does not hold the two directories
 *   every survey area publishes.
 */
export async function downloadSurveyArea(options: DownloadSurveyAreaOptions): Promise<SurveyAreaArchive> {
	const vintageDirectory = join(options.cacheRoot, options.versionDate)
	const root = join(vintageDirectory, options.areaSymbol)
	const archivePath = join(vintageDirectory, `wss_SSA_${options.areaSymbol}.zip`)

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
				// Every progress line names the area, because a full acquisition interleaves hundreds of them.
				...(options.onProgress
					? { onProgress: (message: string) => options.onProgress?.(`${options.areaSymbol}: ${message}`) }
					: {}),
			})
		}

		// The archive holds its files under an `<AREASYMBOL>/` root already, so it unzips into the vintage directory
		// rather than into a directory named for itself.
		await execFileAsync("unzip", ["-o", "-q", archivePath, "-d", vintageDirectory])
	} else {
		options.onProgress?.(`${options.areaSymbol}: already extracted for ${options.versionDate}`)
	}

	const spatialDirectory = join(root, "spatial")
	const tabularDirectory = join(root, "tabular")

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
