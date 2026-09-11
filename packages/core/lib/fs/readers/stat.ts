/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Filesystem metadata readers.
 */

import { AssertionError } from "node:assert"
import type { Dirent, Mode, Stats } from "node:fs"
import {
	open as openNative,
	access,
	constants,
	glob,
	lstat,
	readlink,
	realpath,
	stat,
	type FileHandle,
} from "node:fs/promises"

import { type PathBuilderLike, resolvePath } from "path-ts"

import { ByteFormatter, type ByteFormatterOptions } from "#fs/formatters"

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
 * Assert that a path exists, throwing an error if it does not.
 */
export function assertPathExists(path: PathBuilderLike | URL, message?: string): Promise<void> {
	return pathExists(path).then((exists) => {
		if (exists) return void 0

		throw new AssertionError({
			message: message ?? `Expected path to exist`,
			expected: path.toString(),
			actual: "not found",
		})
	})
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
export function asTarget(path: PathBuilderLike | URL): URL | string {
	return path instanceof URL ? path : path.toString()
}

// #endregion
