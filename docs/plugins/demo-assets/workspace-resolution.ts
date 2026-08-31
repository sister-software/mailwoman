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
 * Resolve a package's source entry, falling back to compiled output when source is unavailable.
 */
export async function resolvePackageEntry(packageName: string): Promise<string | null> {
	const source = resolvePackagePath(packageName, "index.ts")

	if (source && (await pathExists(source))) return source

	return resolvePackagePath(packageName, "out", "index.js")
}

/**
 * Resolve a single-file package subpath such as `objects.ts`.
 */
export async function resolvePackageFile(packageName: string, subpath: string): Promise<string | null> {
	const source = resolvePackagePath(packageName, `${subpath}.ts`)

	if (source && (await pathExists(source))) return source

	return resolvePackagePath(packageName, "out", `${subpath}.js`)
}

/**
 * Resolve a directory package subpath such as `decoder/index.ts`.
 */
export async function resolvePackageDirectoryEntry(packageName: string, subpath: string): Promise<string | null> {
	const source = resolvePackagePath(packageName, subpath, "index.ts")

	if (source && (await pathExists(source))) return source

	return resolvePackagePath(packageName, "out", subpath, "index.js")
}
