/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Filesystem readers that use glob patterns to match files.
 */

import type { Dirent } from "node:fs"
import { glob as globNative } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { type PathBuilder, resolvePath } from "path-ts"

export type GlobPattern = string | PathBuilder

export type GlobPatternInput = GlobPattern | readonly GlobPattern[]

interface GlobCommonOptions {
	/**
	 * Directory from which patterns are evaluated.
	 *
	 * Relative paths are resolved against `process.cwd()`.
	 */
	cwd?: string | PathBuilder | URL

	/**
	 * Glob patterns to exclude.
	 */
	exclude?: ReadonlyArray<string | PathBuilder>

	/**
	 * Yield only non-directory entries.
	 *
	 * This matches fast-glob's `onlyFiles` semantics more closely than `Dirent.isFile()`, since symlinks and other
	 * non-directory entries are retained.
	 *
	 * @default true
	 */
	onlyFiles?: boolean

	/**
	 * Follow symbolic links when traversing directories.
	 *
	 * @default false
	 */
	followSymlinks?: boolean

	/**
	 * Abort iteration.
	 */
	signal?: AbortSignal
}

export interface GlobStringOptions extends GlobCommonOptions {
	withFileTypes?: false

	/**
	 * Yield absolute paths instead of paths relative to `cwd`.
	 *
	 * @default true
	 */
	absolute?: boolean
}

export interface GlobDirentOptions extends GlobCommonOptions {
	/**
	 * Yield `Dirent`s instead of path strings.
	 *
	 * `Dirent.parentPath` is absolute because `Glob` normalizes `cwd` before invoking Node's glob implementation.
	 */
	withFileTypes: true
}

export type GlobOptions = GlobStringOptions | GlobDirentOptions

/**
 * Lazily walk files matching one or more glob patterns.
 *
 * Yields {@link Dirent} entries when `withFileTypes` is `true`.
 *
 * Unlike `node:fs/promises.glob`, this wrapper:
 *
 * - Yields only non-directory entries by default;
 * - Normalizes `Dirent.parentPath` to an absolute path;
 * - Supports cancellation through `AbortSignal`.
 */
export function glob(pattern: GlobPatternInput, options: GlobDirentOptions): AsyncIterable<Dirent>

/**
 * Lazily walk files matching one or more glob patterns.
 *
 * Yields absolute path strings by default. Set `absolute` to `false` to yield paths relative to `cwd`.
 */
export function glob(pattern: GlobPatternInput, options?: GlobStringOptions): AsyncIterable<string>

export async function* glob(pattern: GlobPatternInput, options: GlobOptions = {}): AsyncIterable<string | Dirent> {
	const cwd = resolveCwd(options.cwd)
	const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map(String)

	const onlyFiles = options.onlyFiles ?? true
	const exclude = options.exclude ? Array.from(options.exclude, String) : undefined

	options.signal?.throwIfAborted()

	const entries = globNative(patterns, {
		cwd,
		withFileTypes: true,
		exclude,
		followSymlinks: options.followSymlinks,
	})

	for await (const entry of entries) {
		options.signal?.throwIfAborted()

		if (onlyFiles && entry.isDirectory()) continue

		if (options.withFileTypes) {
			yield entry

			continue
		}

		const path = join(entry.parentPath, entry.name)

		yield options.absolute === false ? relative(cwd, path) : path
	}
}

function resolveCwd(cwd?: string | PathBuilder | URL): string {
	if (!cwd) return process.cwd()

	const normalized = cwd instanceof URL ? fileURLToPath(cwd) : cwd

	return resolvePath(normalized)
}
