/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Derives replacement specifiers from package `imports`/`exports` patterns or relative path arithmetic.
 *
 * A mapped specifier is re-derived by running the same pattern that produced it, so a form the maps cannot express is
 * a form this module cannot emit.
 */

import { dirname, relative } from "path-ts"

/**
 * A package manifest as this module reads it: the directory it sits in and the two subpath maps.
 */
export interface PackageManifest {
	/**
	 * The package directory, repo-relative.
	 */
	dir: string
	name: string
	imports?: Record<string, unknown>
	exports?: Record<string, unknown>
}

/**
 * Specifiers that name one file, by the family each is written in.
 */
export interface PackageSpecifiers {
	/**
	 * `#`-prefixed and read from the package's `imports` map.
	 * It is package-private, so a test file may not write one.
	 */
	internal: string[]
	/**
	 * `<package name>` or `<package name>/<subpath>`, from the `exports` map.
	 */
	bare: string[]
}

/**
 * A replacement never crosses families, because the family decides who may write the specifier.
 */
export const SpecifierFamily = {
	Relative: "relative",
	Internal: "internal",
	Bare: "bare",
} as const

export type SpecifierFamily = (typeof SpecifierFamily)[keyof typeof SpecifierFamily]

const SOURCE_EXTENSION = /\.(?:m|c)?[jt]sx?$/u

/**
 * A replacement that changes family changes who is allowed to write it, so this is the
 * predicate a rewrite is filtered by rather than a description of one.
 */
export function specifierFamily(specifier: string): SpecifierFamily {
	if (specifier.startsWith(".")) return SpecifierFamily.Relative

	if (specifier.startsWith("#")) return SpecifierFamily.Internal

	return SpecifierFamily.Bare
}

function conditionTargets(value: unknown): string[] {
	if (typeof value === "string") return [value]

	if (Array.isArray(value)) return value.flatMap(conditionTargets)

	if (value && typeof value === "object") return Object.values(value).flatMap(conditionTargets)

	return []
}

/**
 * A pattern entry substitutes exactly one `*`, as Node does.
 *
 * The target's text before and after the star must bracket the path.
 * The intervening text becomes the key's star.
 */
function subpathKeyFor(key: string, target: string, packageRelative: string): string | null {
	const star = target.indexOf("*")

	if (star === -1) return target === packageRelative ? key : null

	const keyStar = key.indexOf("*")

	if (keyStar === -1 || key.lastIndexOf("*") !== keyStar || target.lastIndexOf("*") !== star) return null

	const head = target.slice(0, star)
	const tail = target.slice(star + 1)

	if (!packageRelative.startsWith(head) || !packageRelative.endsWith(tail)) return null

	if (packageRelative.length <= head.length + tail.length) return null

	return `${key.slice(0, keyStar)}${packageRelative.slice(head.length, packageRelative.length - tail.length)}${key.slice(keyStar + 1)}`
}

function packageRelativeTarget(manifest: PackageManifest, file: string): string | undefined {
	if (!file.startsWith(`${manifest.dir}/`)) return undefined

	return `./${file.slice(manifest.dir.length + 1)}`
}

/**
 * Every specifier that names `file` under `manifest`'s own maps, where a file outside
 * the package answers an empty list because both paths are repo-relative.
 */
export function packageSpecifiersFor(manifest: PackageManifest, file: string): PackageSpecifiers {
	const packageRelative = packageRelativeTarget(manifest, file)
	const internal = new Set<string>()
	const bare = new Set<string>()

	if (!packageRelative) return { internal: [], bare: [] }

	for (const [key, value] of Object.entries(manifest.imports ?? {})) {
		if (!key.startsWith("#")) continue

		for (const target of conditionTargets(value)) {
			const matched = subpathKeyFor(key, target, packageRelative)

			if (matched) {
				internal.add(matched)
			}
		}
	}

	for (const [key, value] of Object.entries(manifest.exports ?? {})) {
		if (!key.startsWith(".")) continue

		for (const target of conditionTargets(value)) {
			const matched = subpathKeyFor(key, target, packageRelative)

			if (matched) {
				bare.add(matched === "." ? manifest.name : `${manifest.name}${matched.slice(1)}`)
			}
		}
	}

	return { internal: [...internal], bare: [...bare] }
}

/**
 * The relative specifier that reaches `target` from `containingFile`,
 * with `keepExtension` mirroring the replaced specifier because a relative import
 * includes an explicit `.ts` under Node's type stripping.
 */
export function relativeSpecifier(containingFile: string, target: string, keepExtension: boolean): string {
	const path: string = relative(dirname(containingFile), target)
	const bare = keepExtension ? path : path.replace(SOURCE_EXTENSION, "")

	return bare.startsWith(".") ? bare : `./${bare}`
}

/**
 * Whether a specifier writes its file extension.
 * This decides the form of a relative replacement.
 */
export function hasSourceExtension(specifier: string): boolean {
	return SOURCE_EXTENSION.test(specifier)
}

/**
 * Candidates ordered so the one sharing the longest prefix with the specifier being replaced comes first
 * and a shorter specifier wins a tie, since ordering decides which proven candidate is written.
 */
export function orderByLikeness(specifier: string, candidates: readonly string[]): string[] {
	const sharedPrefix = (candidate: string): number => {
		let index = 0

		while (index < candidate.length && index < specifier.length && candidate[index] === specifier[index]) {
			index++
		}

		return index
	}

	return [...candidates].toSorted((a, b) => sharedPrefix(b) - sharedPrefix(a) || a.length - b.length)
}
