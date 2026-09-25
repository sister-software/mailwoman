/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locates installed packages on disk through module resolution from `@mailwoman/core`.
 */

import { fileURLToPath } from "node:url"

import { dirname, PathBuilder, resolvePath } from "path-ts"

/**
 * Returns the directory of an installed package.
 *
 * The function resolves `<package>/package.json` so that data-only packages
 * without a `main` entry still resolve.
 * The package must expose `./package.json` in its `exports` map.
 *
 * For a workspace package, the result is the real workspace directory
 * because `import.meta.resolve` follows the symlink.
 *
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed.
 */
export function resolvePackageDirectory<Name extends string = string>(packageName: Name): PathBuilder<Name> {
	const manifestPath = fileURLToPath(import.meta.resolve(`${packageName}/package.json`))

	return PathBuilder.from(dirname(manifestPath)) as unknown as PathBuilder<Name>
}

/**
 * Returns a path inside an installed package, relative to the package root.
 *
 * Anchoring at the package root gives the same path from the source tree,
 * the compiled `out/` tree and a published tarball.
 * For example, `resolvePackagePath("mailwoman", "lib", "eval-harness", "baselines.json")`.
 *
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed.
 */
export function resolvePackagePath(packageName: string, ...segments: string[]): string {
	return resolvePath(resolvePackageDirectory(packageName), ...segments)
}

/**
 * Resolves a bare module specifier, such as `onnxruntime-web`, to a filesystem
 * path through its package's `exports` map.
 *
 * Resolution starts from this module.
 * It finds every workspace package and every hoisted dependency.
 *
 * It cannot find a package installed only in a nested `node_modules`.
 * Use `resolve-from.ts` for that case.
 *
 * @throws `ERR_MODULE_NOT_FOUND` when the specifier does not resolve.
 */
export function resolveModulePath(specifier: string): string {
	return fileURLToPath(import.meta.resolve(specifier))
}

/**
 * Behaves like {@link resolveModulePath} but returns `null` when the specifier does not resolve.
 */
export function tryResolveModulePath(specifier: string): string | null {
	try {
		return resolveModulePath(specifier)
	} catch {
		return null
	}
}

/**
 * Behaves like {@link resolvePackageDirectory} but returns `null` when the package is not installed.
 */
export function tryResolvePackageDirectory<Name extends string = string>(packageName: Name): PathBuilder<Name> | null {
	try {
		return resolvePackageDirectory(packageName)
	} catch {
		return null
	}
}

export { createRequire } from "node:module"
