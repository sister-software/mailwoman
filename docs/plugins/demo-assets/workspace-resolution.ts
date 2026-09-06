/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Source-first resolution of a workspace's files for the docs webpack build: each probe prefers the TypeScript
 *   under `lib/` and falls back to `out/`, so the demo bundles source where it exists.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { resolvePackagePathFrom } from "@mailwoman/core/module/resolve-from"

/**
 * The directory a workspace keeps its TypeScript in, relative to the package root.
 *
 * Each source probe below is followed by an `out/` fallback, so a probe aimed at the WRONG directory does not fail
 * loudly — it silently hands the demo bundle compiled JavaScript instead of the source the alias exists to select. That
 * is what happened when source moved here from the package root, and only `webpack-policy.test.ts` noticed.
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
 * Resolve a directory package subpath such as `decoder/index.ts`.
 */
export async function resolvePackageDirectoryEntry(packageName: string, subpath: string): Promise<string | null> {
	const source = resolvePackagePathFrom(import.meta.url, packageName, SourceDirectoryName, subpath, "index.ts")

	if (await pathExists(source)) return source

	return existingCompiledFile(resolvePackagePathFrom(import.meta.url, packageName, "out", subpath, "index.js"))
}

/**
 * An alias that points at a missing file breaks the client bundle at the first import, while a skipped alias falls
 * through to the package's own exports map, which is the correct answer for a subpath the alias list has outgrown.
 */
async function existingCompiledFile(target: string): Promise<string | null> {
	if (await pathExists(target)) return target

	console.warn(`[demo-assets] ${target} does not exist — alias skipped`)

	return null
}
