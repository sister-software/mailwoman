/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locate a package from the CALLER's location: every helper takes `base`, the caller's `import.meta.url`, so a
 *   package resolves through the graph of the workspace that declares it rather than through `@mailwoman/core`'s. The
 *   sibling `resolvers.ts` anchors on this module instead, which is the right answer for core's own files and for
 *   anything visible from core, and the wrong one for a dependency only a docs plugin or a hook carries.
 *
 *   Two constructs are kept out of this module on purpose, because the Docusaurus config loader evaluates a plugin and
 *   everything it imports through jiti's CommonJS transform, which rewrites `import.meta.url` in the plugin and refuses
 *   two things it meets elsewhere: a bare `import.meta`, which `resolvers.ts` carries as `import.meta.resolve`, and an
 *   `import … with { type: "json" }`, which it reports as a template-literal error. The manifest is therefore read
 *   through `#fs/readers`, and a plugin imports this module and never `resolvers.ts`.
 */

import { createRequire, findPackageJSON } from "node:module"

import { dirname, join, resolvePath } from "path-ts"
import type { PackageJson } from "type-fest"

import { readLocalJSONFile } from "#fs/readers"

/**
 * The path to a package's `package.json`.
 *
 * @param base The caller's `import.meta.url`.
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed where `base` can see it.
 */
export function resolvePackageJSON(base: string, packageName: string): string {
	const manifestPath = findPackageJSON(packageName, base)

	if (!manifestPath) {
		throw new Error(`Could not find a package.json for ${packageName}`)
	}

	return manifestPath
}

/**
 * A file under a package's directory, by segments from its root.
 *
 * @param base The caller's `import.meta.url`.
 */
export function resolvePackagePathFrom(base: string, packageName: string, ...segments: string[]): string {
	return resolvePath(dirname(resolvePackageJSON(base, packageName)), ...segments)
}

export type PackageJSONLike<D extends object = object> = PackageJson & D

/**
 * Read and parse a package's `package.json`, given its path from {@link resolvePackageJSON}.
 */
export async function readPackageJSON<D extends object = object>(manifestPath: string): Promise<PackageJSONLike<D>>

/**
 * Read and parse a package's `package.json`, resolving the package from the caller's `import.meta.url`.
 */
export async function readPackageJSON<D extends object = object>(
	base: string,
	packageName: string
): Promise<PackageJSONLike<D>>

export async function readPackageJSON<D extends object = object>(
	first: string,
	packageName?: string
): Promise<PackageJSONLike<D>> {
	const manifestPath = packageName === undefined ? first : resolvePackageJSON(first, packageName)

	return readLocalJSONFile<PackageJSONLike<D>>(manifestPath)
}

/**
 * A package subpath as a filesystem path, resolved through the package's `exports` map, so a caller can read or spawn a
 * file the package publishes.
 *
 * @param base The caller's `import.meta.url`.
 * @throws `ERR_MODULE_NOT_FOUND` when the specifier does not resolve.
 */
export function resolvePackageSpecifier(base: string, packageName: string, ...subpaths: (string | null)[]): string {
	return createRequire(base).resolve(
		join(packageName, ...subpaths.filter((subpath): subpath is string => typeof subpath === "string"))
	)
}

/**
 * {@link resolvePackageSpecifier}, answering `null` instead of throwing for a specifier that does not resolve.
 */
export function tryResolvePackageSpecifier(
	base: string,
	packageName: string,
	...subpaths: (string | null)[]
): string | null {
	try {
		return resolvePackageSpecifier(base, packageName, ...subpaths)
	} catch {
		return null
	}
}
