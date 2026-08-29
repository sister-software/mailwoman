/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC availability-file download + zip extraction.
 */

import { extractSingleFileZip } from "@mailwoman/core/fs/zip"
import * as fs from "@mailwoman/platform/fs/promises"
import * as path from "@mailwoman/platform/path"

import type { BDCClient } from "./client.ts"
import { BDCFilingDataType, type BDCFile } from "./common.ts"

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
