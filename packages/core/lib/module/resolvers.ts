/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locate an installed package on disk through module resolution, so a caller never hand-assembles a
 *   `node_modules/...` path.
 */

import { fileURLToPath } from "node:url"

import { dirname, PathBuilder, resolvePath } from "path-ts"

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
 * A CommonJS `require` bound to a module's location, for the resolution shapes only `require.resolve` answers — a
 * package's `main` for a bundler alias, a file under a package that declares no `exports` — and for the one loader (the
 * Docusaurus config) that runs where `import.meta` does not exist.
 */
export { createRequire } from "node:module"
