/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The QRank candidate list: every Wikidata item ranked by its Wikimedia pageviews over the past 52 weeks.
 *
 * QRank is published at `https://qrank.toolforge.org/` by Sascha Brawer. Its homepage states "The QRank data
 * is dedicated to the Public Domain via Creative Commons Zero 1.0", and its `datapackage.json` lists the
 * license as `CC0-1.0`, so the list adds no share-alike term to the selection.
 *
 * The file is one gzip-compressed CSV with the columns `Entity,QRank`, sorted by decreasing rank, about
 * 126 MB compressed (measured 2026-11-04: 126,008,420 bytes for the 2026-11-01 build). The host answers range
 * requests with 206, so {@linkcode downloadQRank} resumes an interrupted transfer, and `datapackage.json`
 * names the current build's version and sha256. The re-run check compares both before downloading again.
 */

import type { APIClient } from "@mailwoman/core/api"
import { gunzipChunks } from "@mailwoman/core/fs/compression"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { resumableDownload } from "#tools/fetch/download"
import { formatElapsed, type ProgressReporter } from "#tools/fetch/wikidata/vital-places/progress"

/**
 * The current QRank build, under its undated name.
 */
export const QRANK_DOWNLOAD_URL = "https://qrank.toolforge.org/download/qrank.csv.gz"

/**
 * The Data Package descriptor naming the current build, its byte count and its sha256.
 */
export const QRANK_DATAPACKAGE_URL = "https://qrank.toolforge.org/download/datapackage.json"

/**
 * The license QRank's homepage and `datapackage.json` state for the data.
 */
export const QRANK_LICENSE = "CC0-1.0"

/**
 * The file name the list is kept under.
 */
export const QRANK_FILENAME = "qrank.csv.gz"

/**
 * The receipt written beside the list, so a rerun can tell whether the host has a newer build.
 */
export const QRANK_RECEIPT_FILENAME = "qrank.json"

/**
 * How far the download advances between progress lines.
 */
const QRANK_PROGRESS_EVERY_BYTES = 16 * 1024 * 1024

/**
 * What `datapackage.json` states about the current build, reduced to the fields the re-run check reads.
 */
export interface QRankDatapackage {
	/**
	 * The build date, such as `2026-11-01`.
	 */
	version: string
	/**
	 * The dated file name, such as `qrank-20261101.csv.gz`.
	 */
	path: string
	bytes: number
	/**
	 * The hex sha256 of the compressed file.
	 */
	sha256: string
	/**
	 * The license name the descriptor states, such as `CC0-1.0`.
	 */
	license: string
}

/**
 * The receipt {@linkcode downloadQRank} writes beside the list.
 */
export interface QRankReceipt extends QRankDatapackage {
	source_url: string
	downloaded_at: string
	filename: string
}

/**
 * One row of the list.
 */
export interface QRankRow {
	qid: string
	qrank: number
}

interface DatapackageBody {
	version?: unknown
	licenses?: Array<{ name?: unknown }>
	resources?: Array<{ path?: unknown; bytes?: unknown; hash?: unknown }>
}

/**
 * Read the current build's descriptor.
 *
 * A descriptor missing one of the fields the re-run check compares is refused by name
 * rather than read as a build that never matches.
 */
export async function readQRankDatapackage(client: Pick<APIClient, "fetch">): Promise<QRankDatapackage> {
	const response = await client.fetch<DatapackageBody>({ url: QRANK_DATAPACKAGE_URL })
	const body = response.data
	const resource = body.resources?.[0]
	const hash = typeof resource?.hash === "string" ? resource.hash : null
	const license = body.licenses?.[0]?.name

	if (typeof body.version !== "string") throw new Error(`${QRANK_DATAPACKAGE_URL}: version is not a string`)

	if (typeof resource?.path !== "string") throw new Error(`${QRANK_DATAPACKAGE_URL}: resources[0].path is not a string`)

	if (typeof resource.bytes !== "number")
		throw new Error(`${QRANK_DATAPACKAGE_URL}: resources[0].bytes is not a number`)

	if (!hash?.startsWith("sha256:")) throw new Error(`${QRANK_DATAPACKAGE_URL}: resources[0].hash is not a sha256`)

	if (typeof license !== "string") throw new Error(`${QRANK_DATAPACKAGE_URL}: licenses[0].name is not a string`)

	return {
		version: body.version,
		path: resource.path,
		bytes: resource.bytes,
		sha256: hash.slice("sha256:".length),
		license,
	}
}

/**
 * Whether the list on disk is the build the descriptor names.
 *
 * The receipt's version and byte count decide, then the file's own length.
 * The digest was checked when the file arrived.
 */
export async function isQRankCurrent(
	recorded: QRankReceipt | null,
	current: QRankDatapackage,
	path: PathBuilderLike
): Promise<boolean> {
	if (!recorded) return false

	if (recorded.version !== current.version || recorded.sha256 !== current.sha256) return false

	return pathExists(path)
}

export interface DownloadQRankOptions {
	/**
	 * The directory the list and its receipt are written under.
	 */
	destDir: PathBuilderLike
	retryDelayMs?: number
	report?: ProgressReporter
}

/**
 * Download the current build unless the list on disk is already that build, and answer its receipt.
 *
 * A list whose receipt matches the descriptor costs one small request.
 * A downloaded file whose sha256 differs from the descriptor's is refused rather than read.
 *
 * A descriptor stating a license other than {@linkcode QRANK_LICENSE} is refused too,
 * because the election covers CC0 and no other license.
 */
export async function downloadQRank(
	client: Pick<APIClient, "fetch">,
	options: DownloadQRankOptions
): Promise<QRankReceipt> {
	const { report } = options
	const destDir = PathBuilder.from(options.destDir)
	const path = destDir(QRANK_FILENAME)
	const receiptPath = destDir(QRANK_RECEIPT_FILENAME)
	const current = await readQRankDatapackage(client)

	if (current.license !== QRANK_LICENSE) {
		throw new Error(`${QRANK_DATAPACKAGE_URL} states license ${current.license}; the election covers ${QRANK_LICENSE}`)
	}

	const recorded = (await pathExists(receiptPath)) ? await readLocalJSONFile<QRankReceipt>(receiptPath) : null

	if (await isQRankCurrent(recorded, current, path)) {
		report?.(`  qrank: build ${current.version} already on disk (${formatQuantity(current.bytes)} bytes), no download`)

		return recorded!
	}

	report?.(`  qrank: downloading build ${current.version} (${formatQuantity(current.bytes)} bytes)`)

	const startedAt = performance.now()

	const bytes = await resumableDownload({
		url: QRANK_DOWNLOAD_URL,
		dest: path,
		headers: { accept: "application/gzip, */*" },
		retryDelayMs: options.retryDelayMs,
		progressEveryBytes: QRANK_PROGRESS_EVERY_BYTES,
		report,
	})

	const sha256 = await sha256File(path)

	if (sha256 !== current.sha256) {
		throw new Error(`${QRANK_FILENAME}: sha256 ${sha256} differs from the descriptor's ${current.sha256}`)
	}

	const receipt: QRankReceipt = {
		...current,
		source_url: QRANK_DOWNLOAD_URL,
		downloaded_at: new Date().toISOString(),
		filename: QRANK_FILENAME,
	}

	await writeLocalJSONFile(receipt, receiptPath)

	report?.(`  qrank: ${formatQuantity(bytes)} bytes in ${formatElapsed(startedAt)}, sha256 verified`)

	return receipt
}

/**
 * One CSV row under the publisher's own column spelling.
 */
interface QRankCSVRow {
	Entity?: string
	QRank?: string
}

/**
 * The first `limit` rows of the list, in the file's own descending-rank order.
 *
 * The gzip stream is read as far as the limit and no further.
 * A row without both columns is refused by line rather than skipped.
 */
export async function* readTopQRank(path: PathBuilderLike, limit: number): AsyncGenerator<QRankRow> {
	if (limit <= 0) return

	const bytes = gunzipChunks(openReadStream(path))
	let line = 1
	let read = 0

	// The publisher's spelling is indexed as is: the default key normalization rewrites `QRank` to `q_rank`.
	for await (const row of CSVSpliterator.fromAsync<QRankCSVRow>(bytes, { normalizeKeys: false })) {
		line++

		const qid = row.Entity
		const qrank = Number(row.QRank)

		if (!qid || !/^Q[1-9]\d*$/u.test(qid) || !Number.isInteger(qrank) || qrank < 1) {
			throw new Error(`${PathBuilder.from(path).toString()}:${line}: not an Entity,QRank row`)
		}

		yield { qid, qrank }

		if (++read >= limit) return
	}
}
