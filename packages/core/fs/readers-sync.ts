/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The synchronous read surface — the same contracts as `./readers.ts`, blocking.
 *
 *   A synchronous read blocks the event loop, so `./readers.ts` is the surface a call site reaches for. This one is
 *   for a slot whose caller is synchronous and not ours to change — a React state initializer, a Docusaurus plugin
 *   method, a class constructor, a `.filter()` predicate, the `ShardResolver` on the geocode hot path.
 *
 *   This module exists so those positions still reach a HELPER rather than the builtin. The names carry the same
 *   contracts as their asynchronous siblings — `statPathSync` raises ENOENT where `tryStatSync` answers null,
 *   `removePathSync` raises where `removePathIfPresentSync` forgives — so moving a call site between the two surfaces
 *   is a rename, and no reader has to re-derive what a builtin's options meant.
 *
 *   `packages/core/fs/*` is the only place that reaches `node:fs`.
 */

import {
	accessSync,
	constants,
	globSync,
	lstatSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
	type Dirent,
	type Stats,
} from "node:fs"

import { type PathBuilderLike, resolvePath } from "path-ts"

import { parseJSONStrict } from "#objects"

// #region Stat utils

/**
 * Stat a file or directory, answering `null` when nothing is there.
 *
 * @throws If the path exists but cannot be statted for some reason other than non-existence.
 */
export function tryStatSync(path: PathBuilderLike | URL): Stats | null {
	try {
		return statSync(path instanceof URL ? path : path.toString())
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null

		throw error
	}
}

/**
 * Stat a file or directory, raising ENOENT when nothing is there.
 */
export function statPathSync(path: PathBuilderLike | URL): Stats {
	return statSync(path instanceof URL ? path : path.toString())
}

/**
 * Stat a path without following a symbolic link, so the answer describes the link itself.
 */
export function statLinkSync(path: PathBuilderLike | URL): Stats {
	return lstatSync(path instanceof URL ? path : path.toString())
}

/**
 * Stat a path without following a symbolic link, answering `null` when nothing is there.
 *
 * The link-level counterpart to {@linkcode tryStatSync}, and what `lstatSync(p, { throwIfNoEntry: false })` was spelling
 * out.
 */
export function tryStatLinkSync(path: PathBuilderLike | URL): Stats | null {
	try {
		return lstatSync(path instanceof URL ? path : path.toString())
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null

		throw error
	}
}

/**
 * Whether a path exists, whatever it is.
 *
 * Unlike the builtin `existsSync`, a path that cannot be READ raises rather than reporting absence: EACCES on a parent
 * directory is not the same answer as "there is nothing here", and conflating them is how a reader reports a gap it
 * never measured.
 *
 * Prefer the asynchronous {@linkcode pathExists} in almost all cases.
 *
 * @deprecated Use {@linkcode pathExists} instead.
 */
export function pathExistsSync(path: PathBuilderLike | URL): boolean {
	return tryStatSync(path) !== null
}

/**
 * Whether a path exists and is a directory.
 */
export function isDirectorySync(path: PathBuilderLike | URL): boolean {
	return tryStatSync(path)?.isDirectory() ?? false
}

/**
 * Whether a path exists and is a file.
 */
export function isFileSync(path: PathBuilderLike | URL): boolean {
	return tryStatSync(path)?.isFile() ?? false
}

/**
 * Resolve a path to its canonical location, following every symbolic link.
 *
 * @throws ENOENT when nothing is there.
 */
export function realPathSync(path: PathBuilderLike): string {
	return realpathSync(path.toString())
}

/**
 * The target a symbolic link points at, verbatim.
 */
export function readLinkSync(path: PathBuilderLike): string {
	return readlinkSync(path.toString())
}

/**
 * Whether the process may WRITE to a path. Absence reads as `false`.
 */
export function isWritableSync(path: PathBuilderLike): boolean {
	try {
		accessSync(path.toString(), constants.W_OK)

		return true
	} catch {
		return false
	}
}

/**
 * Whether the process may EXECUTE a path. Absence reads as `false`.
 */
export function isExecutableSync(path: PathBuilderLike): boolean {
	try {
		accessSync(path.toString(), constants.X_OK)

		return true
	} catch {
		return false
	}
}

/**
 * Every path matching a glob pattern, sorted.
 */
export function globPathsSync(pattern: string | string[]): string[] {
	return [...globSync(pattern)].toSorted()
}

/**
 * A `file:` URL is passed through whole: `node:fs` accepts the object and rejects the string it prints.
 */
function asTarget(path: PathBuilderLike | URL): URL | string {
	return path instanceof URL ? path : path.toString()
}

// #endregion

// #region Readers

/**
 * The first segment may be a `file:` URL, which `node:fs` accepts as an object and rejects as the string it prints.
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
 */
export function readLocalTextFileSync<S extends Array<PathBuilderLike | URL>>(...pathSegments: S): string {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	return readFileSync(readTarget(pathSegments), "utf8")
}

/**
 * Read a local JSON file, parsed strictly.
 */
export function readLocalJSONFileSync<
	T = Record<string, unknown>,
	S extends Array<PathBuilderLike | URL> = Array<PathBuilderLike | URL>,
>(...pathSegments: S): T {
	return parseJSONStrict<T>(readLocalTextFileSync(...pathSegments))
}

/**
 * Read a local file's bytes.
 */
export function readLocalBufferSync<S extends Array<PathBuilderLike | URL>>(...pathSegments: S): Buffer {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	return readFileSync(readTarget(pathSegments))
}

/**
 * List the entry names directly inside a directory.
 */
export function readDirectorySync(path: PathBuilderLike | URL): string[] {
	return readdirSync(asTarget(path))
}

/**
 * List a directory's entries with their types, so a caller can tell a file from a directory without a stat apiece.
 */
export function readDirectoryEntriesSync(path: PathBuilderLike | URL): Dirent[] {
	return readdirSync(asTarget(path), { withFileTypes: true })
}

/**
 * List every entry under a directory, at any depth, as paths relative to it.
 */
export function readDirectoryRecursiveSync(path: PathBuilderLike | URL): string[] {
	return readdirSync(asTarget(path), { recursive: true }) as string[]
}

/**
 * List every entry under a directory, at any depth, WITH its type — `Dirent.parentPath` names the directory each was
 * found in, which a plain recursive read leaves the caller to reconstruct.
 */
export function readDirectoryEntriesRecursiveSync(path: PathBuilderLike | URL): Dirent[] {
	return readdirSync(asTarget(path), { recursive: true, withFileTypes: true })
}

/**
 * List a directory's entry names, answering an empty list when the directory does not exist.
 *
 * An absent directory and an empty one are the same answer here. Where absence means something, use
 * {@linkcode readDirectorySync} and let the ENOENT reach you.
 */
export function tryReadDirectorySync(path: PathBuilderLike | URL): string[] {
	try {
		return readdirSync(asTarget(path))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []

		throw error
	}
}

// #endregion
