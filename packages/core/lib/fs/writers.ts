/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Asynchronous file-system writers that take a {@linkcode PathBuilderLike} and return a promise.
 *
 *   Every file writer creates the parent directory first.
 */

import { appendFile, chmod, copyFile, cp, mkdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"

import { dirname, type PathBuilderLike, resolvePath } from "path-ts"
import { createNewlineWriter } from "spliterator"

import type { Stats } from "#fs/readers"
import { statPath } from "#fs/readers/stat"
import { prettyJSON, stringifyJSON, type StringifiedJSON } from "#json"

// #region Directories

/**
 * Creates each directory and any missing parents, like `mkdir -p`.
 *
 * @param paths The paths to create in parallel.
 *
 * @returns The same paths, for chaining.
 */
export function makeDirectories<T extends PathBuilderLike[]>(...paths: T): Promise<T> {
	return Promise.all(paths.map((path) => mkdir(path.toString(), { recursive: true }))).then(() => paths)
}

/**
 * Creates one directory and rejects with `EEXIST` when the path already exists.
 *
 * A non-recursive `mkdir` is an atomic test-and-set, and the repository's inter-process
 * locks depend on it. {@linkcode makeDirectories} succeeds on an existing directory,
 * so it cannot replace this function for a lock.
 */
export function makeDirectoryExclusive(path: PathBuilderLike): Promise<void> {
	return mkdir(path.toString()).then(() => undefined)
}

// #endregion

// #region Files

/**
 * Data that `writeFile` accepts as file content.
 *
 * @internal
 */
export type BufferLike =
	| NodeJS.ArrayBufferView
	| Iterable<string | NodeJS.ArrayBufferView>
	| AsyncIterable<string | NodeJS.ArrayBufferView>

/**
 * Writes a local text file.
 *
 * A string is written as is.
 * Any other iterable of strings is written one element per line, and every line
 * ends with a newline, including the last.
 * An empty iterable writes an empty file.
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

	// A string is also an `Iterable<string>` of characters, so it must be handled before the line writer.
	const resolved = await content

	if (typeof resolved === "string") return writeFile(filePath, resolved, "utf8")

	// The Docusaurus config loader parses this module with Babel without `explicitResourceManagement`,
	// so this block uses `try`/`finally` in place of `await using`.
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
 * Joins lines with a newline after each one, including the last.
 * An empty array returns an empty string.
 *
 * The output matches what {@linkcode writeLocalTextFile} writes for an iterable.
 */
export function toLinesText(lines: readonly string[]): string {
	return lines.length ? `${lines.join("\n")}\n` : ""
}

/**
 * Writes a tab-indented local JSON file.
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
 * Writes a JSONL file with one JSON value per line, each followed by a newline.
 *
 * `JSONSpliterator.fromAsync` reads these files back.
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
 * Writes bytes to a local file.
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
 * Writes a UTF-8 text file that only its owner can read and write (`0600`), such as a signing key.
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
	// Setting the mode at creation keeps a new file private from the start.
	// `writeFile` keeps an existing file's mode, so `changeMode` also runs afterwards.
	await writeFile(filePath, await content, { encoding: "utf8", mode: 0o600 })
	await changeMode(filePath, 0o600)
}

/**
 * Writes a local file whose content may be text or bytes.
 *
 * Use {@linkcode writeLocalTextFile} or {@linkcode writeLocalBuffer} when the content type is known.
 *
 * @category Files
 * @runtime node
 */
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
 * Appends text to a local file and creates the file and its parent directory when needed.
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
 * Removes a file, or a directory and everything under it.
 *
 * @throws {Error} If the path does not exist.
 * @see {@linkcode removePathIfPresent} for a version that ignores a missing path.
 */
export function removePath(path: PathBuilderLike): Promise<void> {
	return rm(path.toString(), { recursive: true })
}

/**
 * Removes a directory and everything under it.
 *
 * @param path The directory to remove.
 * @param cachedStats Stats for the directory, when the caller already has them.
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
 * Removes a file.
 *
 * @param path The file to remove.
 * @param cachedStats Stats for the file, when the caller already has them.
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
 * Removes a file or directory tree and succeeds when the path is missing, like `rm -rf`.
 */
export function removePathIfPresent(path: PathBuilderLike): Promise<void> {
	return rm(path.toString(), { recursive: true, force: true })
}

/**
 * Copies a file or directory tree and creates the destination's parent directory first.
 *
 * @param source The file or directory to copy.
 * @param destination The destination path.
 */
export async function copyPath(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const target = destination.toString()

	await mkdir(dirname(target), { recursive: true })

	return cp(source.toString(), target, { recursive: true })
}

/**
 * Copies one file and replaces whatever is at the destination.
 *
 * The destination is removed first because `copyFile` onto a symlink writes
 * through the link and leaves the link in place.
 */
export async function copyFileTo(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const target = destination.toString()

	await mkdir(dirname(target), { recursive: true })
	await rm(target, { force: true })

	return copyFile(source.toString(), target)
}

/**
 * Moves a file or directory with `rename` and creates the destination's parent directory first.
 *
 * `rename` is atomic and fails across filesystems.
 * Use {@linkcode copyPath} and then {@linkcode removePathIfPresent}
 * when the paths may be on different devices.
 */
export async function movePath(source: PathBuilderLike, destination: PathBuilderLike): Promise<void> {
	const target = destination.toString()

	await mkdir(dirname(target), { recursive: true })

	return rename(source.toString(), target)
}

/**
 * Creates a symbolic link and replaces whatever is at the link path.
 *
 * The existing path is removed first because `symlink` fails with `EEXIST` on an existing path.
 *
 * @param target The path the link points to.
 * @param linkPath The path of the link itself.
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
 * Changes a path's permission bits.
 */
export function changeMode(path: PathBuilderLike, mode: number | string): Promise<void> {
	return chmod(path.toString(), mode)
}

/**
 * Sets a path's access and modification times.
 */
export function setTimestamps(
	path: PathBuilderLike,
	accessedAt: number | string | Date,
	modifiedAt: number | string | Date
): Promise<void> {
	return utimes(path.toString(), accessedAt, modifiedAt)
}
