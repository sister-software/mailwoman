/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The asynchronous read surface. Every reader here takes a {@linkcode PathBuilderLike} and answers a promise.
 *
 *   `node:fs` is reached from this directory alone, and every reader answers a promise: no executable repository
 *   code makes a blocking filesystem call, and the `debt` check in `packages/repo-health` counts any that appears.
 */

import type { Dirent, Stats } from "node:fs"
import { readFile, readdir } from "node:fs/promises"

import { type PathBuilderLike, resolvePath } from "path-ts"

import { asTarget, open } from "#fs/readers/stat"
import { parseJSONStrict } from "#json"

export {
	entryLeadsToDirectory,
	formatFileSize,
	globPaths,
	isDirectory,
	isExecutable,
	isFile,
	isSymbolicLink,
	isWritable,
	open,
	pathExists,
	readFileSize,
	readLink,
	realPath,
	statLink,
	statPath,
	tryRealPath,
	tryStat,
	tryStatLink,
} from "#fs/readers/stat"

export type { Dirent, PathLike, Stats } from "node:fs"
export type { FileHandle } from "node:fs/promises"

// #region File Readers

/**
 * Read the first `byteSize` bytes of a file, or the whole file if it is smaller.
 *
 * @param path The file to read.
 * @param byteSize How many bytes to read. Defaults to 65,536, which is enough to sniff a file's format.
 *
 * @returns The bytes read, as a UTF-8 string.
 * @throws ENOENT when the file does not exist.
 */
export async function readFileHead(path: PathBuilderLike, byteSize: number): Promise<string> {
	// `try`/`finally` rather than `await using`: this module is on the Docusaurus config loader's import path, and its
	// transform does not parse explicit resource management.
	const handle = await open(path, "r")

	try {
		const buffer = Buffer.alloc(byteSize)
		const { bytesRead } = await handle.read(buffer, 0, byteSize, 0)

		return buffer.subarray(0, bytesRead).toString("utf8")
	} finally {
		await handle.close()
	}
}

/**
 * Read `length` bytes from `path`, starting at `offset`.
 *
 * The shape a header peek has: a magic number, a version, an offset to a trailer, then the trailer itself — three reads
 * at three positions, where reading the whole file would mean loading a multi-gigabyte artifact to look at sixteen
 * bytes.
 *
 * Answers what it actually read, which is shorter than `length` at end of file.
 *
 * @throws ENOENT when the file does not exist.
 */
export async function readFileRange(path: PathBuilderLike, offset: number, length: number): Promise<Buffer> {
	const handle = await open(path.toString(), "r")

	try {
		const buffer = Buffer.alloc(length)
		const { bytesRead } = await handle.read(buffer, 0, length, offset)

		return buffer.subarray(0, bytesRead)
	} finally {
		await handle.close()
	}
}

/**
 * The first segment may be a `file:` URL, which `node:fs` accepts as an object and rejects as the string it prints.
 * `resolvePath` would stringify it, so a URL is passed through whole and never joined.
 */
function readTarget(pathSegments: Array<PathBuilderLike | URL>): URL | string {
	const [first] = pathSegments

	if (first instanceof URL) {
		if (pathSegments.length > 1) throw new Error("A URL is a whole path; it takes no further segments.")

		return first
	}

	return resolvePath(...(pathSegments as PathBuilderLike[]))
}

/**
 * Read a local text file.
 *
 * @category Node
 * @category Files
 */
export function readLocalTextFile<S extends Array<PathBuilderLike | URL>>(...pathSegments: S): Promise<string> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	return readFile(readTarget(pathSegments), "utf8")
}

/**
 * @deprecated Use `readLocalJSONFile` instead
 */
export function readLocalJSONFile<_T = Record<string, unknown>>(path: `${string}/package.json`): Promise<never>

/**
 * Read a local JSON file.
 *
 * Parsing is strict: a file that is not JSON throws here rather than answering `undefined` several frames later.
 *
 * @category Node
 * @category Files
 * @see `readPackageJSON` in `#module/resolve-from` for a `package.json`, which answers the manifest shape and takes a
 *   package name as readily as a path.
 */
export function readLocalJSONFile<
	T = Record<string, unknown>,
	S extends Array<PathBuilderLike | URL> = Array<PathBuilderLike | URL>,
>(...pathSegments: S): Promise<T>

export function readLocalJSONFile<
	T = Record<string, unknown>,
	S extends Array<PathBuilderLike | URL> = Array<PathBuilderLike | URL>,
>(...pathSegments: S): Promise<T> {
	return readLocalTextFile(...pathSegments).then((content) => parseJSONStrict<T>(content))
}

/**
 * Read a local file's bytes.
 *
 * @category Node
 * @category Files
 */
export function readLocalBuffer<S extends Array<PathBuilderLike | URL>>(...pathSegments: S): Promise<Buffer> {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	return readFile(readTarget(pathSegments))
}

/**
 * List the entry names directly inside a directory.
 *
 * @category Node
 * @category Files
 */
export function readDirectory(path: PathBuilderLike | URL): Promise<string[]> {
	return readdir(asTarget(path))
}

/**
 * List a directory's entries with their types, so a caller can tell a file from a directory without a stat apiece.
 *
 * @category Node
 * @category Files
 */
export function readDirectoryEntries(path: PathBuilderLike | URL): Promise<Dirent[]> {
	return readdir(asTarget(path), { withFileTypes: true })
}

/**
 * List every entry under a directory, at any depth, as paths relative to it.
 *
 * The recursive counterpart to {@linkcode readDirectory}. It walks the whole tree before answering, so it is the wrong
 * reader for a directory whose size is unknown — reach for it where the tree is a build artifact you produced.
 *
 * @category Node
 * @category Files
 */
export function readDirectoryRecursive(path: PathBuilderLike | URL): Promise<string[]> {
	return readdir(asTarget(path), { recursive: true })
}

/**
 * List every entry under a directory, at any depth, WITH its type — `Dirent.parentPath` names the directory each was
 * found in, which a plain recursive read leaves the caller to reconstruct.
 */
export function readDirectoryEntriesRecursive(path: PathBuilderLike | URL): Promise<Dirent[]> {
	return readdir(asTarget(path), { recursive: true, withFileTypes: true })
}

/**
 * List a directory's entry names, answering an empty list when the directory does not exist.
 *
 * The distinction is the caller's to make and this function makes ONE of the two available: an absent directory and an
 * empty one are the same answer here. Where absence means something — an unbuilt artifact, a missing extract — use
 * {@linkcode readDirectory} and let the ENOENT reach you.
 *
 * @category Node
 * @category Files
 */
export function tryReadDirectory(path: PathBuilderLike | URL): Promise<string[]> {
	return readdir(asTarget(path)).catch((error) => {
		if (error.code === "ENOENT") return []

		throw error
	})
}

// #endregion

// #region Standard input

/**
 * Drain standard input.
 *
 * A hook or a filter reads its payload from file descriptor 0, which is not a path — none of the readers above accepts
 * one, and `fsPromises.readFile` does not take a bare descriptor either. Streaming the handle is the asynchronous way
 * to say the same thing, and it lives here so a caller does not re-derive it.
 */
export async function readStandardInput(): Promise<string> {
	return Buffer.concat(await Array.fromAsync(process.stdin)).toString("utf8")
}

/**
 * Drain standard input and parse it as JSON, strictly.
 *
 * The standard-input counterpart to {@linkcode readLocalJSONFile}.
 */
export async function readStandardInputJSON<T = Record<string, unknown>>(): Promise<T> {
	return parseJSONStrict<T>(await readStandardInput())
}

// #endregion
