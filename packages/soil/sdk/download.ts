/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire one survey area's published archive — 13 to 41 MB streamed to disk and unzipped.
 *
 *   THIS IS A FILE TRANSFER, NOT AN API REQUEST, AND IT KEEPS RAW `fetch` ON PURPOSE. The repo's rule sends
 *   HTTP clients through `@mailwoman/core/api`'s `APIClient`, and the rule draws its line at what that class
 *   is for: pacing, bounded retry, response caching and error mapping over small bodies and repeated calls.
 *   None of it applies here. Caching a 25 MB body through a JSON-validating disk cache would write a second,
 *   unreadable copy of a file already on disk; there is nothing to pace, because this runs once per survey
 *   area per product vintage; and axios buffers any non-stream response type in memory.
 *   `packages/osm/sdk/fetch.ts`, `packages/tiger/sdk/download.ts` and `packages/flood/sdk/download.ts` are
 *   the existing transfers that say the same thing in the same place. The METADATA reads around this one do
 *   go through `APIClient` — see `client.ts`.
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

import { execFile } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

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
 * Bytes between progress reports.
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

	if (!(await exists(root))) {
		await mkdir(vintageDirectory, { recursive: true })

		if (await exists(archivePath)) {
			options.onProgress?.(`${options.areaSymbol}: archive for ${options.versionDate} already downloaded`)
		} else {
			await streamToDisk(options, archivePath)
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
		if (!(await exists(directory))) {
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

/**
 * Stream the archive to `archivePath` through a `.part` file.
 */
async function streamToDisk(options: DownloadSurveyAreaOptions, archivePath: string): Promise<void> {
	const url = surveyAreaArchiveURL(options.areaSymbol, options.versionDate)
	const partialPath = `${archivePath}.part`

	options.onProgress?.(`${options.areaSymbol}: downloading ${url}`)

	const response = await fetch(url)

	if (!response.ok || !response.body) {
		throw new Error(
			`soil download: ${url} answered HTTP ${response.status}${
				response.status === UNKNOWN_VERSION_STATUS
					? " — this host answers 400 rather than 404 for a version date it does not hold, so check the date against sacatalog.saverest"
					: ""
			}`
		)
	}

	let received = 0
	let reported = 0

	const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])

	source.on("data", (chunk: Buffer) => {
		received += chunk.byteLength

		if (received - reported >= PROGRESS_STRIDE_BYTES) {
			reported = received

			options.onProgress?.(`${options.areaSymbol}: ${(received / 1024 / 1024).toFixed(0)} MB`)
		}
	})

	try {
		await pipeline(source, createWriteStream(partialPath))
	} catch (error) {
		await rm(partialPath, { force: true })

		throw error
	}

	await rename(partialPath, archivePath)

	options.onProgress?.(`${options.areaSymbol}: downloaded ${received.toLocaleString()} bytes`)
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false
	)
}
