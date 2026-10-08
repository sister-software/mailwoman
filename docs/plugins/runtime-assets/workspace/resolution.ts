/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Source-first resolution of a workspace's files for the docs webpack build: each probe prefers the TypeScript
 *   under `lib/` and falls back to `out/`, so the site bundles source where it exists.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePackagePathFrom } from "@mailwoman/core/module/resolve-from"

/**
 * The directory a workspace keeps its TypeScript in, relative to the package root.
 *
 * Each source probe below is followed by an `out/` fallback, so a probe aimed at the wrong
 * directory does not fail loudly — it silently hands the site bundle compiled JavaScript
 * instead of the source the alias exists to select.
 * The source move from the package root caused that failure.
 * Only `webpack-policy.test.ts` detected it.
 */
const SourceDirectoryName = "lib"

/**
 * Resolve a package's source entry, falling back to compiled output when source is unavailable.
 */
export async function resolvePackageEntry(packageName: string): Promise<string | null> {
	const source = resolvePackagePathFrom(import.meta.url, packageName, SourceDirectoryName, "index.ts")

	if (await pathExists(source)) return source

	return resolvePackagePathFrom(import.meta.url, packageName, "out", "index.js")
}

/**
 * Resolve a single-file package subpath such as `objects.ts`.
 */
export async function resolvePackageFile(packageName: string, subpath: string): Promise<string | null> {
	const source = resolvePackagePathFrom(import.meta.url, packageName, SourceDirectoryName, `${subpath}.ts`)

	if (await pathExists(source)) return source

	return existingCompiledFile(resolvePackagePathFrom(import.meta.url, packageName, "out", `${subpath}.js`))
}

/**
 * An alias that points at a missing file breaks the client bundle at its first import.
 *
 * A skipped alias falls through to the package's exports map.
 * That resolves a subpath the alias list does not cover.
 */
async function existingCompiledFile(target: string): Promise<string | null> {
	if (await pathExists(target)) return target

	console.warn(`[runtime-assets] ${target} does not exist — alias skipped`)

	return null
}
