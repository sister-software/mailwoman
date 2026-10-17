/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The identity of the Geofabrik extract a build reads: the URL it came from, the SHA-256 of its bytes,
 *   and the date of the OpenStreetMap snapshot inside it.
 *
 *   A Geofabrik `-latest` URL serves a new file every day, so the URL alone never identifies the input.
 *   The digest does. `tools/fetch/extract.ts` writes a receipt beside each download, and this module reads
 *   it back and checks the file still has the bytes the receipt recorded.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { sha256File } from "@mailwoman/core/hash"
import { isoDate } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import type { GeofabrikExtractReceipt } from "#sdk/fetch"

/**
 * The input-file provenance an OpenStreetMap layer manifest records.
 */
export interface ExtractProvenance {
	/**
	 * The URL the extract was downloaded from.
	 */
	sourceURL: string
	/**
	 * The SHA-256 of the extract's bytes as lowercase hex, measured by this build.
	 */
	sourceSHA256: string
	/**
	 * The `YYYY-MM-DD` date of the server's `Last-Modified` header, which dates the snapshot.
	 *
	 * `null` when the extract has no receipt or the server sent no such header.
	 */
	snapshotDate: string | null
}

/**
 * The receipt path `tools/fetch/extract.ts` writes beside an extract.
 */
export function extractReceiptPath(pbf: PathBuilderLike): string {
	return `${pbf.toString()}.receipt.json`
}

/**
 * Read an extract's provenance from its receipt, or from the URL the caller states.
 *
 * The extract is hashed in both cases.
 * With a receipt, a digest that differs from the recorded one throws, because the
 * manifest would otherwise name a download the file no longer holds.
 *
 * A caller URL that differs from the receipt's throws for the same reason.
 * Without a receipt, the caller must state the URL, because a manifest with no
 * source cannot be traced to the data it holds.
 *
 * @throws When the receipt and the file disagree, or when neither a receipt nor a URL is available.
 */
export async function readExtractProvenance(
	pbf: PathBuilderLike,
	options: { sourceURL?: string } = {}
): Promise<ExtractProvenance> {
	const receiptPath = extractReceiptPath(pbf)
	const sourceSHA256 = await sha256File(pbf)

	if (!(await pathExists(receiptPath))) {
		if (!options.sourceURL) {
			throw new Error(
				`${pbf.toString()} has no receipt at ${receiptPath}. Download it with packages/osm/tools/fetch/extract.ts, ` +
					"which writes one, or pass --source-url with the address it was downloaded from."
			)
		}

		return { sourceURL: options.sourceURL, sourceSHA256, snapshotDate: null }
	}

	const receipt = await readLocalJSONFile<GeofabrikExtractReceipt>(receiptPath)

	if (receipt.sha256 !== sourceSHA256) {
		throw new Error(
			`${pbf.toString()} hashes to ${sourceSHA256}, and its receipt ${receiptPath} records ${receipt.sha256}. ` +
				"The file changed after it was downloaded. Download it again so the manifest records the bytes it was built from."
		)
	}

	if (options.sourceURL && options.sourceURL !== receipt.source_url) {
		throw new Error(
			`--source-url ${options.sourceURL} differs from the receipt's source_url ${receipt.source_url} for ${pbf.toString()}`
		)
	}

	const lastModified = receipt.last_modified ? new Date(receipt.last_modified) : null

	return {
		sourceURL: receipt.source_url,
		sourceSHA256,
		snapshotDate: lastModified && Number.isFinite(lastModified.getTime()) ? isoDate(lastModified) : null,
	}
}
