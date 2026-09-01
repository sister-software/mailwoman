/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Zip readers, in two flavours — buffer-in for archives already in memory, path-in for archives on disk.
 *
 *   {@link extractZip} and {@link extractSingleFileZip} take the whole archive as a `Buffer`, which is the right shape
 *   when a client has just downloaded one (`bdc/sdk/download.ts`) and the wrong shape for anything sizable: adm-zip
 *   holds the archive AND the decompressed member resident at once. The national address dumps under
 *   `$MAILWOMAN_DATA_ROOT` are 0.5–2.9 GB compressed and up to 9 GB unpacked, so the path-in readers below stream —
 *   yauzl seeks the central directory over a file handle and inflates one member on demand, at constant memory
 *   regardless of archive size.
 *
 *   The path-in readers also handle ZIP64, which the dumps need: a member above 4 GB parks `0xFFFFFFFF` in the 32-bit
 *   size and offset slots and carries the real values in the entry's extra field.
 */

import { createWriteStream } from "node:fs"
import { pipeline } from "node:stream/promises"
import { crc32 } from "node:zlib"

import ADMZip from "adm-zip"
import { resolvePath, dirname, basename, type PathBuilderLike } from "path-ts"
import { open as openArchive, type Entry, type ZipFileOptions } from "yauzl-promise"

import { tryStat } from "#fs/readers"
import { makeDirectories } from "#fs/writers"

type StreamingArchive = Awaited<ReturnType<typeof openArchive>>

type EntryStream = Awaited<ReturnType<Entry["openReadStream"]>>

/**
 * The one place this package touches yauzl's own lifecycle. Every reader below ends an archive by leaving scope, so
 * `close()` is called here and nowhere else.
 */
async function openStreamingArchive(archivePath: PathBuilderLike): Promise<StreamingArchive & AsyncDisposable> {
	const archive = await openArchive(String(archivePath))

	return Object.assign(archive, { [Symbol.asyncDispose]: () => archive.close() })
}

/**
 * One member's decompressed byte stream, ended when the owning scope exits.
 *
 * Node's own `Readable[Symbol.asyncDispose]` cannot serve here. A consumer that stops early has already destroyed the
 * stream with an `AbortError`, and that disposer waits on the stream's end event and re-raises it — turning a
 * deliberate `break` into a throw. Destroying without a reason ends the stream on every path and reports none of them.
 */
async function openEntryStream(entry: Entry, options?: ZipFileOptions): Promise<EntryStream & AsyncDisposable> {
	const contents = await entry.openReadStream(options)

	return Object.assign(contents, {
		[Symbol.asyncDispose]: async () => {
			contents.destroy()
		},
	})
}

export type ZipEntryContentPair = [entry: ADMZip.IZipEntry, content: Buffer]

/**
 * Extract the contents of a zip file.
 *
 * @category Files
 * @internal
 */
export function extractZip(data: ArrayBuffer | Buffer): Map<ADMZip.IZipEntry, Buffer> {
	const normalizedData = data instanceof ArrayBuffer ? Buffer.from(data) : data
	const zip = new ADMZip(normalizedData)

	const pairs = zip
		.getEntries()
		.map((entry) => [entry, zip.readFile(entry)])
		.filter((pair): pair is ZipEntryContentPair => pair[1] !== null)

	if (!pairs.length) {
		throw new Error("No entry pairs found in zip file.")
	}

	return new Map<ADMZip.IZipEntry, Buffer>(pairs)
}

/**
 * Extract the contents of a zip file and return the first entry.
 */
export function extractSingleFileZip(data: ArrayBuffer | Buffer): Promise<Buffer> {
	const normalizedData = data instanceof ArrayBuffer ? Buffer.from(data) : data
	const zip = new ADMZip(normalizedData)

	const [entry] = zip.getEntries()

	// We use the async version of getData to avoid blocking the event loop.
	return new Promise<Buffer>((resolve, reject) =>
		// oxlint-disable-next-line no-promise-executor-return -- return the callback registration from this expression-bodied executor
		entry!.getDataAsync((extractedData, error) => {
			if (error) {
				reject(error)
			} else {
				resolve(extractedData)
			}
		})
	)
}

/**
 * Names a member of an archive, either exactly or by pattern.
 *
 * A pattern matches the FIRST entry whose full archive-internal path tests true, in central-directory order.
 */
export type ZipEntrySelector = string | RegExp

/**
 * One archive member, as reported by the central directory.
 *
 * @category Files
 */
export interface ZipEntryInfo {
	/**
	 * The archive-internal path, e.g. `it/countrywide.csv`. Directory entries keep their trailing slash.
	 */
	name: string
	compressedSize: number
	uncompressedSize: number
}

function selectorMatches(selector: ZipEntrySelector, name: string): boolean {
	return typeof selector === "string" ? name === selector : selector.test(name)
}

/**
 * List an archive's members without decompressing any of them.
 *
 * @category Files
 */
export async function listZipEntries(archivePath: PathBuilderLike): Promise<ZipEntryInfo[]> {
	await using archive = await openStreamingArchive(archivePath)
	const entries: ZipEntryInfo[] = []

	for await (const entry of archive) {
		entries.push({
			name: entry.filename,
			compressedSize: entry.compressedSize,
			uncompressedSize: entry.uncompressedSize,
		})
	}

	return entries
}

/**
 * Stream one member's decompressed bytes out of an archive on disk.
 *
 * Nothing beyond the central directory and the inflate window is held in memory, so this is bounded by the consumer
 * rather than by the member's size. A consumer that stops early — a `take`, a `break` — destroys the member stream and
 * closes the archive on the way out.
 *
 * @category Files
 * @throws If no member matches `selector`.
 */
export async function* readZipEntry(
	archivePath: PathBuilderLike,
	selector: ZipEntrySelector
): AsyncGenerator<Uint8Array> {
	await using archive = await openStreamingArchive(archivePath)

	for await (const entry of archive) {
		if (!selectorMatches(selector, entry.filename)) continue

		await using contents = await openEntryStream(entry)

		yield* contents

		return
	}

	throw new Error(`No entry matching ${selector} in ${archivePath}`)
}

/**
 * Write one member's decompressed bytes to `destinationPath`.
 *
 * @category Files
 *
 * @returns The number of bytes written, as the central directory reports them.
 * @throws If no member matches `selector`.
 */
export async function extractZipEntry(
	archivePath: PathBuilderLike,
	selector: ZipEntrySelector,
	destinationPath: PathBuilderLike
): Promise<number> {
	await using archive = await openStreamingArchive(archivePath)

	for await (const entry of archive) {
		if (!selectorMatches(selector, entry.filename)) continue

		await pipeline(await entry.openReadStream(), createWriteStream(String(destinationPath)))

		return entry.uncompressedSize
	}

	throw new Error(`No entry matching ${selector} in ${archivePath}`)
}

export interface ExtractZipEntriesOptions {
	/**
	 * Which members to write. Omit for every member.
	 */
	selector?: ZipEntrySelector
	/**
	 * Write each member under its basename rather than its archive-internal path, flattening the tree — `unzip -j`.
	 *
	 * The shapefile archives this exists for carry their siblings in one directory, and the readers downstream expect
	 * them flat.
	 */
	flatten?: boolean
	/**
	 * Reuse a destination file when its byte length matches the member's uncompressed length.
	 */
	skipExisting?: boolean
}

/**
 * Extract members of an archive into `destinationDirectory`.
 *
 * Directory entries are skipped; a nested path is created as needed unless `flatten` is set. Members stream one at a
 * time, so this is bounded by the largest member rather than by the archive.
 *
 * @category Files
 *
 * @returns The archive-internal names of everything written, in central-directory order.
 */
export async function extractZipEntries(
	archivePath: PathBuilderLike,
	destinationDirectory: PathBuilderLike,
	{ selector, flatten = false, skipExisting = false }: ExtractZipEntriesOptions = {}
): Promise<string[]> {
	await using archive = await openStreamingArchive(archivePath)
	const written: string[] = []

	for await (const entry of archive) {
		if (entry.filename.endsWith("/")) continue

		if (selector && !selectorMatches(selector, entry.filename)) continue

		const relative = flatten ? basename(entry.filename) : entry.filename
		const destination = resolvePath(destinationDirectory, relative)

		if (!flatten) {
			await makeDirectories(dirname(destination))
		}

		const existing = skipExisting ? await tryStat(destination) : null

		if (existing?.size !== entry.uncompressedSize) {
			await pipeline(await entry.openReadStream(), createWriteStream(destination))
		}

		written.push(entry.filename)
	}

	return written
}

/**
 * Verify every member's CRC-32 against the value its central-directory header claims — what `unzip -t` is for.
 *
 * This is a corruption check on a download, so it decompresses everything and keeps nothing; the archive is read one
 * member at a time and the checksum is folded chunk by chunk, so memory is bounded by the inflate window.
 *
 * The CRC is computed here rather than delegated to yauzl's `validateCrc32`, which asserts `Cannot validate CRC32 for
 * uncompressed data` on a STORED member — and a corrupt stored member is precisely what this is meant to catch. Folding
 * it locally covers both storage methods with one path.
 *
 * @category Files
 *
 * @returns The number of members checked. @throws If the archive is unreadable, or any member's checksum or length
 * disagrees with its header.
 */
export async function verifyZipIntegrity(archivePath: PathBuilderLike): Promise<number> {
	await using archive = await openStreamingArchive(archivePath)
	let checked = 0

	for await (const entry of archive) {
		if (entry.filename.endsWith("/")) continue

		await using contents = await openEntryStream(entry, { validateCrc32: false })
		let checksum = 0
		let length = 0

		for await (const chunk of contents) {
			checksum = crc32(chunk as Uint8Array, checksum)
			length += (chunk as Uint8Array).length
		}

		if (checksum !== entry.crc32) {
			throw new Error(
				`CRC mismatch in ${archivePath}: ${entry.filename} is 0x${checksum.toString(16)}, header claims 0x${entry.crc32.toString(16)}`
			)
		}

		if (length !== entry.uncompressedSize) {
			throw new Error(
				`Length mismatch in ${archivePath}: ${entry.filename} is ${length} bytes, header claims ${entry.uncompressedSize}`
			)
		}

		checked++
	}

	return checked
}
