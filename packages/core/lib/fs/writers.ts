/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The asynchronous write surface. Every writer here takes a {@linkcode PathBuilderLike} and answers a promise.
 *
 *   The companion to `./readers.ts`, and the reason both exist is in that file's header.
 *
 *   Two ceremonies are encoded here rather than repeated at the call site. Every file writer creates the parent
 *   directory first, because the alternative is an enoent that names the file and not the missing directory.
 *   {@linkcode createSymbolicLink} unlinks its destination first, because `symlink` onto an existing path is eexist
 *   and `copyFile` onto an existing symlink writes through it — the defect that put symlinks in a publish tarball and
 *   made npm answer http 415.
 */

import { appendFile, chmod, copyFile, cp, mkdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"

import { dirname, type PathBuilderLike, resolvePath } from "path-ts"
import { createNewlineWriter } from "spliterator"

import type { Stats } from "#fs/readers"
import { statPath } from "#fs/readers/stat"
import { prettyJSON, stringifyJSON, type StringifiedJSON } from "#json"

// #region Directories

/**
 * Create a directory and any missing parent directories, like `mkdir -p`.
 *
 * @param paths The paths to create, run in parallel.
 *
 * @returns The paths that were created, for convenience in chaining.
 */
export function makeDirectories<T extends PathBuilderLike[]>(...paths: T): Promise<T> {
	return Promise.all(paths.map((path) => mkdir(path.toString(), { recursive: true }))).then(() => paths)
}

/**
 * Create one directory, raising eexist when something is already there.
 *
 * The exclusive counterpart to {@linkcode makeDirectories}.
 * It is recursive.
 *
 * Therefore, idempotent.
 * That idempotence is what disqualifies it here: `mkdir` without `recursive` is an atomic
 * test-and-set, and it is how both of this repository's inter-process locks are held.
 *
 * Swapping one for {@linkcode makeDirectories} would let every waiter take the
 * lock at once, and nothing would report it.
 */
export function makeDirectoryExclusive(path: PathBuilderLike): Promise<void> {
	return mkdir(path.toString()).then(() => undefined)
}

// #endregion

// #region Files

/**
 * A buffer-like object that can be written to a file.
 *
 * @internal
 */
export type BufferLike =
	| NodeJS.ArrayBufferView
	| Iterable<string | NodeJS.ArrayBufferView>
	| AsyncIterable<string | NodeJS.ArrayBufferView>

/**
 * Write a local text file, creating its parent directory first.
 *
 * A string is written verbatim.
 * Any other iterable of strings — an array, a `Set`, a generator — is written one
 * element per line, every line terminated including the last: an unterminated final
 * line appends badly and is not what `TextSpliterator` round-trips.
 *
 * An empty iterable writes an empty file rather than a lone newline, because "no lines"
 * and "one blank line" are different files and a bare `join` produces the second.
 *
 * @see {@linkcode writeLocalJSONFile} for a JSON-specific writer that pretty-prints and adds a trailing newline.
 * @category Files
 * @runtime node
 */
export async function writeLocalTextFile<T extends string>(
	content: T extends StringifiedJSON ? never : T | Promise<T>,
	...pathSegments: never[]
): Promise<void>

export async function writeLocalTextFile<S extends PathBuilderLike[]>(
	content: string | Promise<string>,
	...pathSegments: S
): Promise<void>

export async function writeLocalTextFile<S extends PathBuilderLike[]>(
	lines: Iterable<string> | AsyncIterable<string>,
	...pathSegments: S
): Promise<void>

export async function writeLocalTextFile<S extends PathBuilderLike[]>(
	content: string | Promise<string> | Iterable<string> | AsyncIterable<string>,
	...pathSegments: S
): Promise<void> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	await mkdir(dirname(filePath), { recursive: true })

	// A string is itself an `Iterable<string>` over its characters, so settle it before selecting the line writer.
	const resolved = await content

	if (typeof resolved === "string") return writeFile(filePath, resolved, "utf8")

	// `try`/`finally` rather than `await using`, which is equivalent here: this module is
	// in the import graph of the Docusaurus plugins, and that config loader babel-parses
	// its graph without the `explicitResourceManagement` plugin.
	const writer = createNewlineWriter(filePath)

	try {
		for await (const line of resolved) {
			await writer.write(line)
		}
	} finally {
		await writer.dispose()
	}
}

/**
 * One line per element, every line terminated.
 * No elements produces the empty string.
 *
 * The same shape {@linkcode writeLocalTextFile} applies to an iterable,
 * for the sites that build a document and hand it somewhere else.
 * `lines.join("\n")` leaves the last line unterminated, and `lines.join("\n") + "\n"`
 * turns an empty list into a file containing one blank line.
 */
export function toLinesText(lines: readonly string[]): string {
	return lines.length ? `${lines.join("\n")}\n` : ""
}

/**
 * Write a local JSON file, tab-indented, creating its parent directory first.
 *
 * @category Files
 * @runtime node
 */
export function writeLocalJSONFile<T = Record<string, unknown>, S extends PathBuilderLike[] = PathBuilderLike[]>(
	content: T,
	...pathSegments: S
): Promise<void> {
	const normalized = typeof content === "string" ? content : prettyJSON(content)

	return writeLocalTextFile(normalized, ...pathSegments)
}

/**
 * Write one JSON value per line, newline-terminated.
 *
 * The jsonl shape every panel, fixture and result file in this repository is
 * read back with by `JSONSpliterator.fromAsync`.
 *
 * The trailing newline is part of the interface: a file whose last line has
 * none appends badly and diffs noisily.
 *
 * @category Files
 * @runtime node
 */
export function writeLocalJSONLFile<T, S extends PathBuilderLike[] = PathBuilderLike[]>(
	rows: ReadonlyArray<T>,
	...pathSegments: S
): Promise<void> {
	return writeLocalTextFile(
		rows.map((row) => stringifyJSON(row)),
		...pathSegments
	)
}

/**
 * Write a local file's bytes, creating its parent directory first.
 *
 * @category Files
 * @runtime node
 */
export async function writeLocalBuffer<S extends PathBuilderLike[]>(
	content: BufferLike,
	...pathSegments: S
): Promise<void> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	await mkdir(dirname(filePath), { recursive: true })

	return writeFile(filePath, content)
}

/**
 * Write a local file, creating its parent directory first, letting the runtime
 * decide how to encode `content`.
 *
 * Prefer {@linkcode writeLocalTextFile} or {@linkcode writeLocalBuffer}
 * when the call site knows which it has.
 * The name then says so, and a reader does not have to follow the value back to its producer.
 *
 * This overload exists for the sites where it genuinely does not: a payload that
 * is a string on one branch and bytes on another.
 *
 * @category Files
 * @runtime node
 */
/**
 * Write a UTF-8 text file readable and writable by its owner alone (`0600`), creating the parent directory.
 *
 * The mode is applied after the write as well as at creation, because `writeFile`
 * keeps the mode of a file that already exists.
 * For a signing key or any other secret the caller must not leave world-readable.
 */
export async function writePrivateTextFile<S extends PathBuilderLike[]>(
	content: string | Promise<string>,
	...pathSegments: S
): Promise<void> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	await makeDirectories(dirname(filePath))
	// Not `writeLocalTextFile` + `changeMode`: the mode has to be set at creation,
	// or the secret exists world-readable between the two calls.
	// `changeMode` afterwards covers a file that already existed with a wider mode.
	await writeFile(filePath, await content, { encoding: "utf8", mode: 0o600 })
	await changeMode(filePath, 0o600)
}

export async function writeLocalFile<S extends PathBuilderLike[]>(
	content: string | BufferLike,
	...pathSegments: S
): Promise<void> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	await mkdir(dirname(filePath), { recursive: true })

	return writeFile(filePath, content)
}

// #endregion

// #region Appending

/**
 * Append text to a local file, creating it and its parent directory when neither exists.
 *
 * @category Files
 * @runtime node
 */
export async function appendLocalTextFile<S extends PathBuilderLike[]>(
	content: string,
	...pathSegments: S
): Promise<void> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	await mkdir(dirname(filePath), { recursive: true })

	return appendFile(filePath, content, "utf8")
}

// #endregion

/**
 * Remove a file, or a directory and everything under it.
 *
 * @throws {Error} If the path does not exist.
 * @see {@linkcode removePathIfPresent} to not throw if the path does not exist.
 */
export function removePath(path: PathBuilderLike): Promise<void> {
	return rm(path.toString(), { recursive: true })
}

/**
 * Remove a directory and everything under it.
 *
 * @param path The directory to remove.
 * @param cachedStats Optional pre-fetched stats for the directory.
 */
export function removeDirectory(path: PathBuilderLike, cachedStats?: Stats): Promise<void> {
	const resolved = cachedStats ? Promise.resolve(cachedStats) : statPath(path)

	return resolved.then((stats) => {
		if (!stats.isDirectory()) {
			throw new Error(`Path is not a directory: ${path.toString()}`)
		}

		return rm(path.toString(), { recursive: true })
	})
}

/**
 * Remove a file.
 *
 * @param path The file to remove.
 * @param cachedStats Optional pre-fetched stats for the file.
 */
export function removeFile(path: PathBuilderLike, cachedStats?: Stats): Promise<void> {
	const resolved = cachedStats ? Promise.resolve(cachedStats) : statPath(path)

	return resolved.then((stats) => {
		if (!stats.isFile()) {
			throw new Error(`Path is not a file: ${path.toString()}`)
		}

		return rm(path.toString(), { recursive: true })
	})
}

/**
 * Remove a file, or a directory and everything under it, treating absence as success — `rm -rf`.
 */
export function removePathIfPresent(path: PathBuilderLike): Promise<void> {
	return rm(path.toString(), { recursive: true, force: true })
}

/**
 * Copy a file or a directory tree, creating the destination's parent directory first.
 *
 * @param source The file or directory to copy.
 * @param destination Where it lands.
 */
export async function copyPath(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const target = destination.toString()

	await mkdir(dirname(target), { recursive: true })

	return cp(source.toString(), target, { recursive: true })
}

/**
 * Copy one file, replacing whatever is at the destination.
 *
 * The destination is unlinked first: `copyFile` onto a symlink writes through it
 * and leaves the link in place, which is how a materialized weights artifact stayed
 * a symlink and made `npm publish` answer http 415.
 */
export async function copyFileTo(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const target = destination.toString()

	await mkdir(dirname(target), { recursive: true })
	await rm(target, { force: true })

	return copyFile(source.toString(), target)
}

/**
 * Move a file or directory, creating the destination's parent directory first.
 *
 * Rename only, so it does not cross a filesystem boundary, which is the property
 * an atomic publish depends on.
 * Use {@linkcode copyPath} followed by {@linkcode removePathIfPresent}
 * where the two ends may live on different devices.
 */
export async function movePath(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const target = destination.toString()

	await mkdir(dirname(target), { recursive: true })

	return rename(source.toString(), target)
}

/**
 * Point a symbolic link at a target, replacing whatever is already there.
 *
 * @param target What the link points at.
 * @param linkPath Where the link itself lives.
 */
export async function createSymbolicLink(
	target: PathBuilderLike,
	linkPath: PathBuilderLike,
	type?: "file" | "dir" | "junction"
): Promise<void> {
	const link = linkPath.toString()

	await mkdir(dirname(link), { recursive: true })
	await rm(link, { force: true })

	return symlink(target.toString(), link, type)
}

/**
 * Change a path's permission bits.
 */
export function changeMode(path: PathBuilderLike, mode: number | string): Promise<void> {
	return chmod(path.toString(), mode)
}

/**
 * Set a path's access and modification times.
 */
export function setTimestamps(
	path: PathBuilderLike,
	accessedAt: number | string | Date,
	modifiedAt: number | string | Date
): Promise<void> {
	return utimes(path.toString(), accessedAt, modifiedAt)
}
