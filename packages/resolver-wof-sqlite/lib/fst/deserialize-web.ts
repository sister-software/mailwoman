/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-compatible FST reader. Uses DataView + TextDecoder instead of Node's Buffer so the same binary format
 *   loads in the browser and in a Cloudflare Worker through fetch(url).then(r => r.arrayBuffer()).
 *
 *   This is a read-only counterpart to serialize.ts. Serialization stays Node-only because it is a build-time
 *   operation.
 */

import { tryParsingJSON } from "@mailwoman/core/json"

import { BinaryFSTMatcher } from "#fst/binary-matcher"
import { HEADER_SIZE, VERSION_WITH_METADATA } from "#fst/format"
import type { FSTProvenance } from "#fst/types"

/**
 * Opens an FST binary for matching, answering queries from the bytes in place.
 *
 * The matcher keeps a reference to `input`, so the caller must not modify it afterward.
 */
export function deserializeFSTWeb(input: ArrayBuffer | Uint8Array): BinaryFSTMatcher {
	return new BinaryFSTMatcher(input)
}

export function readFSTProvenanceWeb(input: ArrayBuffer | Uint8Array): FSTProvenance | null {
	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const decoder = new TextDecoder("utf-8")

	if (bytes.byteLength < HEADER_SIZE) return null
	const version = view.getUint16(4, true)

	if (version < VERSION_WITH_METADATA) return null
	const provenanceOffset = view.getUint32(28, true)

	if (provenanceOffset === 0 || provenanceOffset >= bytes.byteLength) return null

	try {
		const jsonLen = view.getUint32(provenanceOffset, true)
		const jsonStr = decoder.decode(bytes.subarray(provenanceOffset + 4, provenanceOffset + 4 + jsonLen))

		return tryParsingJSON<FSTProvenance>(jsonStr) ?? null
	} catch {
		return null
	}
}
