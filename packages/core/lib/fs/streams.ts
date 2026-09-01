/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Byte streams over a path, taking a {@linkcode PathBuilderLike} like the rest of `@mailwoman/core/fs`.
 *
 *   A stream is neither the synchronous surface nor the asynchronous one — `createReadStream` returns immediately and
 *   the work happens as the consumer pulls — so it sits in its own module rather than being duplicated across the
 *   pair. It is here for the same reason the readers are: `node:fs` is reached from `@mailwoman/core/fs` alone, and
 *   `packages/core/lib/fs/*` is the only place that reaches it.
 *
 *   These are thin. What they add is the path type and one import site, so a caller that already imports the readers
 *   does not reach past them for a stream.
 */

import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs"

import type { PathBuilderLike } from "path-ts"

/**
 * The runtime's own stream types, re-exported for the same reason the readers re-export theirs.
 */
export type { ReadStream, WriteStream } from "node:fs"
export { Duplex, Readable, Transform, Writable } from "node:stream"
export { finished, pipeline } from "node:stream/promises"

/**
 * Open a path for streaming reads.
 *
 * The stream holds a file descriptor until it ends or is destroyed. Bind it with `using` where the scope owns it, or
 * pipe it somewhere that closes it.
 */
export function openReadStream(path: PathBuilderLike, options?: Parameters<typeof createReadStream>[1]): ReadStream {
	return createReadStream(path.toString(), options)
}

/**
 * Open a path for streaming writes.
 *
 * Unlike the file writers in `./writers.ts`, this does NOT create the parent directory: a stream that fails on the
 * first chunk rather than at open time reports the missing directory somewhere the caller is no longer looking. Call
 * `makeDirectories` first where the parent may be absent.
 */
export function openWriteStream(path: PathBuilderLike, options?: Parameters<typeof createWriteStream>[1]): WriteStream {
	return createWriteStream(path.toString(), options)
}
