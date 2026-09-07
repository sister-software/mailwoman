/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The asynchronous read surface. Every reader here takes a {@linkcode PathBuilderLike} and answers a promise.
 *
 *   `node:fs` is reached from this directory alone, and every reader answers a promise: no executable repository
 *   code makes a blocking filesystem call, and the `debt` check in `packages/repo-health` counts any that appears.
 */

import type { Dirent, Mode, Stats } from "node:fs"
import {
	open as openNative,
	access,
	constants,
	glob,
	lstat,
	readFile,
	readdir,
	readlink,
	realpath,
	stat,
	type FileHandle,
} from "node:fs/promises"

import { type PathBuilderLike, resolvePath } from "path-ts"

import { ByteFormatter, type ByteFormatterOptions } from "#fs/formatters"
import { parseJSONStrict } from "#json"

export type { Dirent, PathLike, Stats } from "node:fs"
export type { FileHandle } from "node:fs/promises"

// #region Stat utils

/**
 * Attempts to stat a file or directory.
 *
 * A `URL` is passed through rather than stringified: `node:fs` accepts a `file:` URL object, and rejects the string it
 * prints — `stat("file:///etc/hostname")` is ENOENT, which this function reports as absence. Every caller that looks a
 * file up by URL therefore read "not there" for everything, and `cli-native/command-router.ts` answered `Unknown
 * command` for every command it has.
 *
 * @throws If the path exists but cannot be statted for some reason other than non-existence.
 */
export function tryStat(pathBuilderLike: PathBuilderLike | URL): Promise<Stats | null> {
	const target = pathBuilderLike instanceof URL ? pathBuilderLike : pathBuilderLike.toString()

	return stat(target).catch((error) => {
		if (error.code === "ENOENT") return null

		throw error
	})
}

/**
 * Stat a file or directory, raising ENOENT when nothing is there.
 *
 * The throwing counterpart to {@linkcode tryStat}. Reach for this one where absence is a defect the caller wants
 * reported, and for {@linkcode tryStat} where absence is an answer.
 */
export function statPath(path: PathBuilderLike | URL): Promise<Stats> {
	return stat(path instanceof URL ? path : path.toString())
}

/**
 * Stat a path without following a symbolic link, so the answer describes the link itself.
 */
export function statLink(path: PathBuilderLike | URL): Promise<Stats> {
	return lstat(path instanceof URL ? path : path.toString())
}

/**
 * Stat a path without following a symbolic link, answering `null` when nothing is there.
 *
 * The link-level counterpart to {@linkcode tryStat}.
 */
export function tryStatLink(path: PathBuilderLike | URL): Promise<Stats | null> {
	return lstat(path instanceof URL ? path : path.toString()).catch((error) => {
		if (error.code === "ENOENT") return null

		throw error
	})
}

/**
 * Whether a path exists, whatever it is.
 *
 * The asynchronous answer to `existsSync`, which is the single most-called synchronous builtin in the repository.
 * Prefer {@linkcode isFile} or {@linkcode isDirectory} where the caller goes on to assume one or the other: a directory
 * where a file was expected passes this check and fails the next line.
 */
export function pathExists(path: PathBuilderLike | URL): Promise<boolean> {
	return tryStat(path).then((stats) => stats !== null)
}

/**
 * Whether a path exists and is a directory.
 */
export function isDirectory(path: PathBuilderLike | URL): Promise<boolean> {
	return tryStat(path).then((stats) => stats?.isDirectory() ?? false)
}

/**
 * Whether a path exists and is a file.
 */
export function isFile(path: PathBuilderLike | URL): Promise<boolean> {
	return tryStat(path).then((stats) => stats?.isFile() ?? false)
}

/**
 * Whether a path exists and is a symbolic link.
 */
export function isSymbolicLink(path: PathBuilderLike | URL): Promise<boolean> {
	return tryStatLink(path).then((stats) => stats?.isSymbolicLink() ?? false)
}

/**
 * Whether a directory entry leads to a directory, symbolic links included.
 *
 * `Dirent.isDirectory()` is FALSE for a symbolic link to a directory, so a walk keyed on it alone skips every linked
 * tree — while a glob with `followSymbolicLinks` (the default) descends into them, and the two then describe different
 * trees. A link is resolved through `stat`, which also answers `false` for a dangling one.
 */
export function entryLeadsToDirectory(entry: Dirent): Promise<boolean> {
	if (entry.isDirectory()) return Promise.resolve(true)

	if (!entry.isSymbolicLink()) return Promise.resolve(false)

	return isDirectory(resolvePath(entry.parentPath, entry.name))
}

/**
 * The size of a file in bytes.
 *
 * @throws ENOENT when the file does not exist.
 */
export function readFileSize(path: PathBuilderLike | URL): Promise<number> {
	return statPath(path).then((stats) => stats.size)
}

/**
 * The size of a file, rendered in IEC units (`12.3 MiB`) — the unit for anything a machine measured.
 *
 * @throws ENOENT when the file does not exist.
 */
export async function formatFileSize(path: PathBuilderLike | URL, options?: ByteFormatterOptions): Promise<string> {
	return ByteFormatter.formatIEC(await readFileSize(path), options)
}

/**
 * Resolve a path to its canonical location, following every symbolic link.
 *
 * @throws ENOENT when nothing is there. {@linkcode tryRealPath} answers `null` instead.
 */
export function realPath(path: PathBuilderLike): Promise<string> {
	return realpath(path.toString())
}

/**
 * Resolve a path to its canonical location, following every symbolic link.
 *
 * @returns The canonical path, or `null` when nothing is there.
 */
export function tryRealPath(path: PathBuilderLike): Promise<string | null> {
	return realpath(path.toString()).catch((error) => {
		if (error.code === "ENOENT") return null

		throw error
	})
}

export function open(path: PathBuilderLike | URL, flags?: string | number, mode?: Mode): Promise<FileHandle> {
	return openNative(path instanceof URL ? path : path.toString(), flags, mode)
}

/**
 * The target a symbolic link points at, verbatim — relative if it was written relative.
 *
 * @throws EINVAL when the path is not a link, ENOENT when nothing is there.
 */
export function readLink(path: PathBuilderLike): Promise<string> {
	return readlink(path.toString())
}

/**
 * Whether the process may WRITE to a path.
 *
 * A permission question, not an existence one: `access` answers about the caller's credentials against the file as it
 * stands, where a stat answers about the file. Absence reads as `false` here, which is what a caller checking "can I
 * write here" means by it.
 */
export function isWritable(path: PathBuilderLike): Promise<boolean> {
	return access(path.toString(), constants.W_OK).then(
		() => true,
		() => false
	)
}

/**
 * Whether the process may EXECUTE a path.
 */
export function isExecutable(path: PathBuilderLike): Promise<boolean> {
	return access(path.toString(), constants.X_OK).then(
		() => true,
		() => false
	)
}

/**
 * Every path matching a glob pattern.
 *
 * Sorted, because `glob` answers in directory order and a build that names its inputs in a receipt should name them the
 * same way twice.
 */
export async function globPaths(pattern: string | string[]): Promise<string[]> {
	return (await Array.fromAsync(glob(pattern))).toSorted()
}

/**
 * A `file:` URL is passed through whole: `node:fs` accepts the object and rejects the string it prints.
 */
function asTarget(path: PathBuilderLike | URL): URL | string {
	return path instanceof URL ? path : path.toString()
}

// #endregion

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
 * @see {@linkcode readPackageJSONFile} for a `package.json`-specific overload that narrows the return type to the package shape.
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
