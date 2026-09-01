/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Package-aware source resolution for the docs webpack build.
 */

// `node:module` directly: the Docusaurus config loader evaluates this file through a CommonJS transform that cannot
// parse `import.meta.resolve`, which `@mailwoman/core/module/resolvers` carries.
import { createRequire } from "node:module"

import { pathExists } from "@mailwoman/core/fs/readers"
import { dirname, join } from "path-ts"

const requireFromPlugin = createRequire(import.meta.url)

/**
 * Resolve a package specifier using the plugin's dependency graph.
 */
export function resolvePackageSpecifier(specifier: string): string | null {
	try {
		return requireFromPlugin.resolve(specifier)
	} catch {
		return null
	}
}

/**
 * Resolve a file relative to an installed package without leaking its root directory to callers.
 */
export function resolvePackagePath(packageName: string, ...segments: string[]): string | null {
	const manifest = resolvePackageSpecifier(`${packageName}/package.json`)

	return manifest ? join(dirname(manifest), ...segments) : null
}

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
	const source = resolvePackagePath(packageName, SourceDirectoryName, "index.ts")

	if (source && (await pathExists(source))) return source

	return resolvePackagePath(packageName, "out", "index.js")
}

/**
 * Resolve a single-file package subpath such as `objects.ts`.
 */
export async function resolvePackageFile(packageName: string, subpath: string): Promise<string | null> {
	const source = resolvePackagePath(packageName, SourceDirectoryName, `${subpath}.ts`)

	if (source && (await pathExists(source))) return source

	return existingCompiledFile(resolvePackagePath(packageName, "out", `${subpath}.js`))
}

/**
 * Resolve a directory package subpath such as `decoder/index.ts`.
 */
export async function resolvePackageDirectoryEntry(packageName: string, subpath: string): Promise<string | null> {
	const source = resolvePackagePath(packageName, SourceDirectoryName, subpath, "index.ts")

	if (source && (await pathExists(source))) return source

	return existingCompiledFile(resolvePackagePath(packageName, "out", subpath, "index.js"))
}

/**
 * An alias that points at a missing file breaks the client bundle at the first import, while a skipped alias falls
 * through to the package's own exports map, which is the correct answer for a subpath the alias list has outgrown.
 */
async function existingCompiledFile(target: string | null): Promise<string | null> {
	if (target && (await pathExists(target))) return target

	console.warn(`[demo-assets] ${target} does not exist — alias skipped`)

	return null
}
