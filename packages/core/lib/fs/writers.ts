/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The asynchronous write surface. Every writer here takes a {@linkcode PathBuilderLike} and answers a promise.
 *
 *   The companion to `./readers.ts`, and the reason both exist is in that file's header.
 *
 *   Two ceremonies are encoded here rather than repeated at the call site. Every file writer creates the parent
 *   directory first, because the alternative is an ENOENT that names the file and not the missing directory.
 *   {@linkcode createSymbolicLink} unlinks its destination first, because `symlink` onto an existing path is EEXIST
 *   and `copyFile` onto an existing symlink writes THROUGH it — the defect that put symlinks in a publish tarball and
 *   made npm answer HTTP 415.
 */

import { appendFile, chmod, copyFile, cp, mkdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"

import { dirname, type PathBuilderLike, resolvePath } from "path-ts"

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
 * Create ONE directory, raising EEXIST when something is already there.
 *
 * The exclusive counterpart to {@linkcode makeDirectories}, which is recursive and therefore idempotent. That
 * idempotence is what disqualifies it here: `mkdir` without `recursive` is an atomic test-and-set, and it is how both
 * of this repository's inter-process locks are held. Swapping one for {@linkcode makeDirectories} would let every waiter
 * take the lock at once, and nothing would report it.
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
 * @category Node
 * @category Files
 */
export async function writeLocalTextFile<S extends PathBuilderLike[]>(
	content: string | Promise<string>,
	...pathSegments: S
): Promise<void> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	await mkdir(dirname(filePath), { recursive: true })

	const data = await content

	return writeFile(filePath, data, "utf8")
}

/**
 * Write a local JSON file, tab-indented, creating its parent directory first.
 *
 * @category Node
 * @category Files
 */
export function writeLocalJSONFile<T = Record<string, unknown>, S extends PathBuilderLike[] = PathBuilderLike[]>(
	content: T,
	...pathSegments: S
): Promise<void> {
	const normalized = typeof content === "string" ? content : JSON.stringify(content, null, "\t") + "\n"

	return writeLocalTextFile(normalized, ...pathSegments)
}

/**
 * Write a local file's bytes, creating its parent directory first.
 *
 * @category Node
 * @category Files
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
 * Write a local file, creating its parent directory first, letting the runtime decide how to encode `content`.
 *
 * Prefer {@linkcode writeLocalTextFile} or {@linkcode writeLocalBuffer} when the call site knows which it has — the name
 * then says so, and a reader does not have to follow the value back to its producer. This overload exists for the sites
 * where it genuinely does not: a payload that is a string on one branch and bytes on another.
 *
 * @category Node
 * @category Files
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

//#region Appending

/**
 * Append text to a local file, creating it and its parent directory when neither exists.
 *
 * @category Node
 * @category Files
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
 * Raises ENOENT when nothing is there. That is the whole difference from {@linkcode removePathIfPresent}, and it is the
 * difference worth spelling in the name: a caller that knows the path exists learns when it does not, and a caller for
 * whom absence is already the desired end state says so.
 */
export function removePath(path: PathBuilderLike): Promise<void> {
	return rm(path.toString(), { recursive: true })
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
 * The destination is unlinked first: `copyFile` onto a SYMLINK writes through it and leaves the link in place, which is
 * how a materialized weights artifact stayed a symlink and made `npm publish` answer HTTP 415.
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
 * Rename only, so it does not cross a filesystem boundary — which is the property an atomic publish depends on. Use
 * {@linkcode copyPath} followed by {@linkcode removePathIfPresent} where the two ends may live on different devices.
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
