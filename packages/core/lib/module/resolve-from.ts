/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolves packages relative to the caller. Every helper takes `base`, the caller's `import.meta.url`, so a package
 *   resolves through the dependency graph of the calling workspace. The sibling `resolvers.ts` resolves from
 *   `@mailwoman/core` instead, which cannot see a dependency that only a docs plugin or a hook declares.
 *
 *   Docusaurus loads plugins through jiti's CommonJS transform, which rejects a bare `import.meta` and
 *   `import … with { type: "json" }`. This module therefore avoids both constructs, and Docusaurus plugins must import
 *   it instead of `resolvers.ts`.
 */

import { createRequire, findPackageJSON } from "node:module"

import { dirname, join, type PathBuilderLike, resolvePath } from "path-ts"
import type { PackageJson } from "type-fest"

import { readLocalJSONFile } from "#fs/readers"

/**
 * Returns the path to a package's `package.json`.
 *
 * @param base The caller's `import.meta.url`.
 * @throws When the package is not installed where `base` can see it.
 */
export function resolvePackageJSON(base: string, packageName: string): string {
	const manifestPath = findPackageJSON(packageName, base)

	if (!manifestPath) {
		throw new Error(`Could not find a package.json for ${packageName}`)
	}

	return manifestPath
}

/**
 * Returns the path of a file under a package's root directory.
 *
 * @param base The caller's `import.meta.url`.
 */
export function resolvePackagePathFrom(base: string, packageName: string, ...segments: string[]): string {
	return resolvePath(dirname(resolvePackageJSON(base, packageName)), ...segments)
}

/**
 * The optional `mailwoman` block in this repository's package manifests.
 *
 * `baseWeights` appears in a data-only weights overlay.
 * It holds the base package that provides the shared `model.onnx` and `tokenizer.model`,
 * and `@mailwoman/neural` reads it to locate those files.
 */
export interface MailwomanManifestFields {
	mailwoman?: {
		baseWeights?: string
	}
}

/**
 * A parsed `package.json` with extra repository-specific fields.
 */
export type PackageJSONLike<D extends object = MailwomanManifestFields> = PackageJson & D

/**
 * Reads and parses a `package.json` at the given path.
 */
export async function readPackageJSON<D extends object = MailwomanManifestFields>(
	manifestPath: PathBuilderLike
): Promise<PackageJSONLike<D>>

/**
 * Reads and parses a package's `package.json`, resolving the package from the caller's `import.meta.url`.
 */
export async function readPackageJSON<D extends object = MailwomanManifestFields>(
	base: string,
	packageName: string
): Promise<PackageJSONLike<D>>

export async function readPackageJSON<D extends object = MailwomanManifestFields>(
	first: PathBuilderLike,
	packageName?: string
): Promise<PackageJSONLike<D>> {
	const manifestPath = packageName === undefined ? first : resolvePackageJSON(first.toString(), packageName)

	return readLocalJSONFile<PackageJSONLike<D>>(manifestPath)
}

/**
 * Resolves a package subpath to a filesystem path through the package's `exports` map.
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
 * Behaves like {@link resolvePackageSpecifier} but returns `null` when the specifier does not resolve.
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
