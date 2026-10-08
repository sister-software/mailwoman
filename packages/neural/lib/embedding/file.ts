/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node readers for a split release's MWE1 embedding row files on local disk.
 */

import { readFileRange, readLocalBuffer } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import { EmbeddingTable, type EmbeddingRangeReader } from "#embedding/rows"

/**
 * Returns a range reader over a local full row file.
 *
 * @throws From the returned reader when the file ends before the requested range does.
 */
export function fileEmbeddingRangeReader(path: PathBuilderLike): EmbeddingRangeReader {
	return async (offset, length) => {
		const bytes = await readFileRange(path, offset, length)

		if (bytes.byteLength !== length) {
			throw new Error(`${path} holds ${bytes.byteLength} of the ${length} bytes at offset ${offset}`)
		}

		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	}
}

/**
 * Opens the embedding table of a split release from its local row files.
 *
 * With a hot subset, the subset stays resident and each other row is read from the full file on first use.
 * Without one, the full file is read whole.
 */
export async function openEmbeddingTable(
	fullPath: PathBuilderLike,
	hotPath?: PathBuilderLike
): Promise<EmbeddingTable> {
	if (hotPath) {
		return EmbeddingTable.fromBytes(new Uint8Array(await readLocalBuffer(hotPath)), fileEmbeddingRangeReader(fullPath))
	}

	return EmbeddingTable.fromBytes(new Uint8Array(await readLocalBuffer(fullPath)))
}
