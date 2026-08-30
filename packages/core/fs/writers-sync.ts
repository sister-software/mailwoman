/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The synchronous write surface — the same contracts as `./writers.ts`, blocking.
 *
 *   Prefer `./writers.ts`. The reasoning, and the positions where a synchronous call is still correct, are in
 *   `./readers-sync.ts`'s header.
 *
 *   The two ceremonies carry over unchanged: every file writer creates the parent directory first, and
 *   {@linkcode copyFileToSync} / {@linkcode createSymbolicLinkSync} clear the destination first, because `copyFile`
 *   onto a symlink writes THROUGH it.
 */

import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	cpSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "@mailwoman/platform/fs"
import { dirname, type PathBuilderLike, resolvePath } from "path-ts"

/**
 * What a SYNCHRONOUS write accepts.
 *
 * Narrower than the asynchronous `BufferLike`: `writeFile` streams an iterable or async-iterable of chunks, and
 * `writeFileSync` has nowhere to stream one to, so it takes a single view.
 */
export type SyncBufferLike = NodeJS.ArrayBufferView

/**
 * Create directories and any missing parents, like `mkdir -p`.
 *
 * @returns The paths that were created, for convenience in chaining.
 */
export function makeDirectoriesSync<T extends PathBuilderLike[]>(...paths: T): T {
	for (const path of paths) {
		mkdirSync(path.toString(), { recursive: true })
	}

	return paths
}

/**
 * Create ONE directory, raising EEXIST when something is already there.
 *
 * The exclusive counterpart to {@linkcode makeDirectoriesSync}. `mkdir` without `recursive` is an atomic test-and-set,
 * and is how this repository's inter-process locks are held.
 */
export function makeDirectoryExclusiveSync(path: PathBuilderLike): void {
	mkdirSync(path.toString())
}

/**
 * Write a local text file, creating its parent directory first.
 */
export function writeLocalTextFileSync<S extends PathBuilderLike[]>(content: string, ...pathSegments: S): void {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	mkdirSync(dirname(filePath), { recursive: true })
	writeFileSync(filePath, content, "utf8")
}

/**
 * Write a local JSON file, tab-indented with a trailing newline, creating its parent directory first.
 */
export function writeLocalJSONFileSync<T = Record<string, unknown>, S extends PathBuilderLike[] = PathBuilderLike[]>(
	content: T,
	...pathSegments: S
): void {
	const normalized = typeof content === "string" ? content : JSON.stringify(content, null, "\t") + "\n"

	writeLocalTextFileSync(normalized, ...pathSegments)
}

/**
 * Write a local file's bytes, creating its parent directory first.
 */
export function writeLocalBufferSync<S extends PathBuilderLike[]>(content: SyncBufferLike, ...pathSegments: S): void {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	mkdirSync(dirname(filePath), { recursive: true })
	writeFileSync(filePath, content)
}

/**
 * Write a local file, creating its parent directory first, letting the runtime decide how to encode `content`.
 */
export function writeLocalFileSync<S extends PathBuilderLike[]>(
	content: string | SyncBufferLike,
	...pathSegments: S
): void {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	mkdirSync(dirname(filePath), { recursive: true })
	writeFileSync(filePath, content)
}

/**
 * Append text to a local file, creating it and its parent directory when neither exists.
 */
export function appendLocalTextFileSync<S extends PathBuilderLike[]>(content: string, ...pathSegments: S): void {
	if (!pathSegments.length) {
		throw new Error("No file path segments provided.")
	}

	const filePath = resolvePath(...pathSegments)

	mkdirSync(dirname(filePath), { recursive: true })
	appendFileSync(filePath, content, "utf8")
}

/**
 * Remove a file, or a directory and everything under it. Raises ENOENT when nothing is there.
 */
export function removePathSync(path: PathBuilderLike): void {
	rmSync(path.toString(), { recursive: true })
}

/**
 * Remove a file, or a directory and everything under it, treating absence as success — `rm -rf`.
 */
export function removePathIfPresentSync(path: PathBuilderLike): void {
	rmSync(path.toString(), { recursive: true, force: true })
}

/**
 * Copy a file or a directory tree, creating the destination's parent directory first.
 */
export function copyPathSync(source: PathBuilderLike, destination: PathBuilderLike): void {
	const target = destination.toString()

	mkdirSync(dirname(target), { recursive: true })
	cpSync(source.toString(), target, { recursive: true })
}

/**
 * Copy one file, replacing whatever is at the destination.
 *
 * The destination is removed first: `copyFile` onto a SYMLINK writes through it and leaves the link in place.
 */
export function copyFileToSync(source: PathBuilderLike, destination: PathBuilderLike): void {
	const target = destination.toString()

	mkdirSync(dirname(target), { recursive: true })
	rmSync(target, { force: true })
	copyFileSync(source.toString(), target)
}

/**
 * Move a file or directory, creating the destination's parent directory first.
 */
export function movePathSync(source: PathBuilderLike, destination: PathBuilderLike): void {
	const target = destination.toString()

	mkdirSync(dirname(target), { recursive: true })
	renameSync(source.toString(), target)
}

/**
 * Point a symbolic link at a target, replacing whatever is already there.
 */
export function createSymbolicLinkSync(
	target: PathBuilderLike,
	linkPath: PathBuilderLike,
	type?: "file" | "dir" | "junction"
): void {
	const link = linkPath.toString()

	mkdirSync(dirname(link), { recursive: true })
	rmSync(link, { force: true })
	symlinkSync(target.toString(), link, type)
}

/**
 * Change a path's permission bits.
 */
export function changeModeSync(path: PathBuilderLike, mode: number | string): void {
	chmodSync(path.toString(), mode)
}

/**
 * Set a path's access and modification times.
 */
export function setTimestampsSync(
	path: PathBuilderLike,
	accessedAt: number | string | Date,
	modifiedAt: number | string | Date
): void {
	utimesSync(path.toString(), accessedAt, modifiedAt)
}
