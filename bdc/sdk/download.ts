/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC availability-file download + zip extraction.
 *
 *   Re-homed from Nexus's `sync/fcc/bdc/download-file.ts` (relicense-by-copy, no provenance headers),
 *   trimmed hard: the Nexus original downloaded AND cached the `.zip`, extracted it, THEN wrote a Parquet
 *   file with a row-count integrity check. All Parquet machinery is dropped here — 2a's `bdc.db` is
 *   SQLite, not Parquet-backed (see Task 7+) — and the `.zip` itself isn't cached either; only the
 *   extracted CSV is written to `destinationDir`, and its presence alone is the cache check.
 *
 *   The zip-extraction library also changes: the Nexus original's `extractSingleFileZip` used `adm-zip`
 *   (a repo-wide Nexus dependency). No unzip dependency exists anywhere in this repo — every workspace
 *   `package.json` was checked, `tiger/` and `osm/` included — so `yauzl-promise` is added to `bdc` alone
 *   (noted in this task's commit body per the brief).
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

import { fromBuffer } from "yauzl-promise"

import type { BDCClient } from "./client.ts"
import { BDCFilingDataType, type BDCFile } from "./common.ts"

/**
 * Extract the first file entry of a zip archive buffer into a single in-memory `Buffer`.
 *
 * BDC availability downloads are always a single zip-wrapped CSV, so — like the Nexus original — this doesn't walk
 * every entry, just the first non-directory one.
 */
async function extractSingleFileZip(zippedBuffer: Buffer): Promise<Buffer> {
	const zip = await fromBuffer(zippedBuffer)

	try {
		for await (const entry of zip) {
			if (entry.filename.endsWith("/")) continue

			const readStream = await entry.openReadStream()
			const chunks: Buffer[] = []

			for await (const chunk of readStream) {
				chunks.push(chunk)
			}

			return Buffer.concat(chunks)
		}

		throw new Error("extractSingleFileZip: no file entries found in zip archive.")
	} finally {
		await zip.close()
	}
}

/**
 * Download and cache an FCC BDC availability file, extracting its zip-wrapped CSV to `destinationDir`.
 *
 * Cache-if-exists: if the extracted CSV already exists at the destination path, this returns immediately without
 * issuing any network request. Otherwise it downloads the zip via `client`, extracts the CSV, writes it to
 * `destinationDir`, and returns the written path. Only the extracted CSV is ever cached — the intermediate `.zip` is
 * never written to disk.
 *
 * THIS FILE OWNS THE CACHE FOR THE DOWNLOAD PATH, which is why `BDCClient.getArrayBuffer` switches the client's own
 * response cache off: the `existsSync`-equivalent check above is the real cache hit, and running a
 * multi-hundred-megabyte archive through a JSON-validating disk cache would write a second, unreadable copy of a file
 * already on disk here.
 *
 * @returns The path of the extracted (and now cached) CSV file.
 */
export async function downloadBDCFile(client: BDCClient, file: BDCFile, destinationDir: string): Promise<string> {
	const csvPath = path.join(destinationDir, `${file.fileName}.csv`)

	const alreadyCached = await fs
		.access(csvPath)
		.then(() => true)
		.catch(() => false)

	if (alreadyCached) return csvPath

	const zippedArrayBuffer = await client.getArrayBuffer(
		`/map/downloads/downloadFile/${BDCFilingDataType.Availability}/${file.fileID}`
	)

	const csvBuffer = await extractSingleFileZip(Buffer.from(zippedArrayBuffer))

	await fs.mkdir(destinationDir, { recursive: true })
	await fs.writeFile(csvPath, csvBuffer)

	return csvPath
}
