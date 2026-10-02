/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The byte stream of an INSPIRE GML publication, whether it arrives zipped or unpacked.
 *
 * Several publishers of the Addresses theme ship one zipped GML for a whole region, and the member
 * inside is far larger than the archive: Wallonia's `AD.Addresses.gml.zip` is 106,665,832 bytes over
 * the wire and holds a single 5,163,917,131-byte member, a ratio of 48. A member that size exceeds
 * what a process may hold, so this hands the caller a chunk sequence and never a buffer.
 *
 * A directory path is not accepted here. A publisher that ships one archive per municipality needs a
 * listing step of its own, and that step belongs to the adapter rather than to this module.
 */

import { openReadStream } from "@mailwoman/core/fs/streams"
import { readZipEntry, type ZipEntrySelector } from "@mailwoman/core/fs/zip"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The inflated bytes of a publication's GML, in order.
 *
 * `inputPath` is either the publisher's `.zip` or a GML file already unpacked from one.
 * Both are read, because an operator who unpacked a multi-gigabyte member once should not
 * have to keep re-inflating it, and because a committed fixture is reviewable only as text.
 *
 * `readZipEntry` seeks the archive's central directory through a file handle and inflates the one
 * matching member, so memory is bounded by the inflate window rather than by the member's size.
 * It also reads the ZIP64 extra field.
 *
 * A 5 GB member needs that field: its 32-bit size slot holds the `0xFFFFFFFF` sentinel
 * and its real length lives in the extra field.
 *
 * @param member Which archive member holds the GML, as a name or a pattern.
 * It is ignored for a path that is already a GML file.
 */
export function inspireGMLChunks(inputPath: PathBuilderLike, member: ZipEntrySelector): AsyncIterable<Uint8Array> {
	const path = PathBuilder.from(inputPath)

	if (path.basename().toLowerCase().endsWith(".zip")) return readZipEntry(path, member)

	return openReadStream(path)
}
