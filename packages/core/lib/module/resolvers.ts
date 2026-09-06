/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locate an installed package on disk through module resolution, so a caller never hand-assembles a
 *   `node_modules/...` path.
 */

import { createRequire, findPackageJSON } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { dirname, PathBuilder, resolvePath } from "path-ts"
import type { PackageJson } from "type-fest"

import { assertDefaultExport } from "#module/assertions"
import { isPresent } from "#objects"

/**
 * The directory of an installed package, located by resolving its `package.json` subpath.
 *
 * Resolving `<package>/package.json` rather than the bare specifier answers for data-only packages that have no `main`.
 * `import.meta.resolve` realpaths through a workspace symlink to the workspace directory, and that string is not
 * internal — it lands in resolved artifact paths, error messages and `mailwoman doctor` output.
 *
 * Throws `ERR_MODULE_NOT_FOUND` when the package is not installed. Every package must expose `./package.json` in its
 * `exports` map for this to resolve.
 */
export function resolvePackageDirectory<Name extends string = string>(packageName: Name): PathBuilder<Name> {
	const manifestPath = fileURLToPath(import.meta.resolve(`${packageName}/package.json`))

	return PathBuilder.from(dirname(manifestPath)) as unknown as PathBuilder<Name>
}

/**
 * A path inside an installed package, anchored at the package root rather than at the calling module — so it answers
 * the same file from the source tree, the compiled `out/` tree and a published tarball. This is how a package reaches
 * its own data files (`resolvePackagePath("mailwoman", "lib", "eval-harness", "baselines.json")`) and how a test names
 * a fixture without walking `..` up from wherever the test sits.
 *
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed.
 */
export function resolvePackagePath(packageName: string, ...segments: string[]): string {
	return resolvePath(resolvePackageDirectory(packageName), ...segments)
}

/**
 * The file a module specifier names, as a filesystem path — a bare package subpath
 * (`@mailwoman/coastal/scripts/ingest-chunk`, `onnxruntime-web`) resolved through its package's `exports` map under
 * this runtime's conditions.
 *
 * Resolution starts from THIS module, so it answers for anything visible from `@mailwoman/core` — every workspace
 * package and every hoisted dependency. A package that only a nested `node_modules` can see is out of reach; that is
 * the one case where a caller's own `import.meta.resolve` says something this cannot. A relative specifier has no
 * business here: a module's own neighbours are `resolvePath(import.meta.dirname, …)`.
 *
 * @throws `ERR_MODULE_NOT_FOUND` when the specifier does not resolve.
 */
export function resolveModulePath(specifier: string): string {
	return fileURLToPath(import.meta.resolve(specifier))
}

/**
 * {@link resolveModulePath}, answering `null` instead of throwing for a specifier that does not resolve.
 */
export function tryResolveModulePath(specifier: string): string | null {
	try {
		return resolveModulePath(specifier)
	} catch {
		return null
	}
}

/**
 * {@link resolvePackageDirectory}, answering `null` instead of throwing for a package that is not installed.
 */
export function tryResolvePackageDirectory<Name extends string = string>(packageName: Name): PathBuilder<Name> | null {
	try {
		return resolvePackageDirectory(packageName)
	} catch {
		return null
	}
}

/**
 * Resolve the path to a package's `package.json` file, so the caller can read it or import it as JSON.
 *
 * @param meta The caller's `import.meta`, so the package resolves from the caller's own location.
 * @param packageName The package to read, as a specifier that resolves from the caller's own location.
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed.
 * @see {@link readPackageJSON} for a convenience that reads and parses the JSON.
 */
export function resolvePackageJSON(meta: ImportMeta, packageName: string): string {
	const manifestPath = findPackageJSON(meta.resolve(packageName))

	if (!manifestPath) {
		throw new Error(`Could not find ${packageName} package.json`)
	}

	return manifestPath
}

export type PackageJSONLike<D extends object = object> = PackageJson & D

/**
 * Read and parse a package's `package.json` file, so the caller can inspect its fields. The JSON is imported as a
 * module, so the caller can use `import.meta.resolve` to locate a package in a workspace or a published tarball.
 *
 * @param {string} manifestPath The path to the package's `package.json`, as returned by {@link resolvePackageJSON}.
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed.
 */
export async function readPackageJSON<D extends object = object>(manifestPath: string): Promise<PackageJSONLike<D>>

/**
 * Read and parse a package's `package.json` file, so the caller can inspect its fields. The JSON is imported as a
 * module, so the caller can use `import.meta.resolve` to locate a package in a workspace or a published tarball.
 *
 * @param {ImportMeta} meta The caller's `import.meta`, so the package resolves from the caller's own location.
 * @param {string} packageName The package to read, as a specifier that resolves from the caller's own location.
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed.
 */
export async function readPackageJSON<D extends object = object>(
	meta: ImportMeta,
	packageName: string
): Promise<PackageJSONLike<D>>

/**
 * Read and parse a package's `package.json` file, so the caller can inspect its fields. The JSON is imported as a
 * module, so the caller can use `import.meta.resolve` to locate a package in a workspace or a published tarball.
 *
 * @param {ImportMeta | string} arg1 The caller's `import.meta`, so the package resolves from the caller's own location,
 *   or the path to the package's `package.json`.
 * @param {string} [arg2] The package to read, as a specifier that resolves from the caller's own location. Required if
 *   `arg1` is `import.meta`.
 * @throws `ERR_MODULE_NOT_FOUND` when the package is not installed.
 */
export async function readPackageJSON<D extends object = object>(
	arg1: ImportMeta | string,
	arg2?: string
): Promise<PackageJSONLike<D>> {
	const manifestPath = typeof arg1 === "string" ? arg1 : resolvePackageJSON(arg1, arg2!)

	const manifest = await import(manifestPath, { with: { type: "json" } }).then((mod) => {
		assertDefaultExport<PackageJSONLike<D>>(mod)

		return mod.default
	})

	return manifest
}

/**
 * Resolve a package specifier to a filesystem path, so the caller can read or import it.
 *
 * @throws `ERR_MODULE_NOT_FOUND` when the specifier does not resolve.
 */
export function resolvePackageSpecifier(meta: ImportMeta, packageName: string, ...subpaths: (string | null)[]): string {
	const require = createRequire(meta.url)
	const filteredSubpaths = subpaths.filter(isPresent)

	return require.resolve(join(packageName, ...filteredSubpaths))
}

/**
 * A CommonJS `require` bound to a module's location, for the resolution shapes only `require.resolve` answers — a
 * package's `main` for a bundler alias, a file under a package that declares no `exports` — and for the one loader (the
 * Docusaurus config) that runs where `import.meta` does not exist.
 */
export { createRequire } from "node:module"
