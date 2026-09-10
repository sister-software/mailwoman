/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Where a replacement specifier comes from: the package's own `imports`/`exports` patterns for a mapped
 *   specifier, and the path arithmetic for a relative one.
 *
 *   Recomputing a path is the wrong operation. TypeScript's `getEditsForFileRename` recomputes, and on a corpus
 *   recipe move it answered `#lib/recipes/fr-fragment` for a test file that had written
 *   `@mailwoman/corpus/recipes/fr/fragment`: it changed the specifier's FAMILY — a public export subpath for a
 *   package-private `#` import — and the `#` form it minted resolves to `packages/corpus/lib/lib/recipes/…`, since
 *   the `#*` pattern already carries the `lib` segment. Both halves of that edit are refused here by construction. A
 *   mapped specifier is re-derived by running the same pattern that produced it, so a form the maps cannot express is
 *   a form this module cannot emit.
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
	 * `#`-prefixed, from the package's `imports` map. Package-private; a test file may not write one.
	 */
	internal: string[]
	/**
	 * `<package name>` or `<package name>/<subpath>`, from the `exports` map.
	 */
	bare: string[]
}

/**
 * The three ways a specifier can name a module here. The family decides who may write it — a `#` import is
 * package-private, a bare specifier is the public contract, a relative path is internal to a directory — so a
 * replacement never crosses from one to another.
 */
export const SpecifierFamily = {
	Relative: "relative",
	Internal: "internal",
	Bare: "bare",
} as const

export type SpecifierFamily = (typeof SpecifierFamily)[keyof typeof SpecifierFamily]

const SOURCE_EXTENSION = /\.(?:m|c)?[jt]sx?$/u

/**
 * Which family a specifier belongs to. A replacement that changes family changes who is allowed to write it, so this is
 * the predicate a rewrite is filtered by rather than a description of one.
 */
export function specifierFamily(specifier: string): SpecifierFamily {
	if (specifier.startsWith(".")) return SpecifierFamily.Relative

	if (specifier.startsWith("#")) return SpecifierFamily.Internal

	return SpecifierFamily.Bare
}

/**
 * Every target string a subpath map entry can carry: a string, a condition object, or a fallback array of either.
 */
function conditionTargets(value: unknown): string[] {
	if (typeof value === "string") return [value]

	if (Array.isArray(value)) return value.flatMap(conditionTargets)

	if (value && typeof value === "object") return Object.values(value).flatMap(conditionTargets)

	return []
}

/**
 * The subpath key that names `target`, or nothing when this entry does not match.
 *
 * A pattern entry substitutes exactly one `*`, as Node does: the target's text before and after the star must bracket
 * the path, and what is left in the middle is what the key's star becomes.
 */
function subpathKeyFor(key: string, target: string, packageRelative: string): string | undefined {
	const star = target.indexOf("*")

	if (star === -1) return target === packageRelative ? key : undefined

	if (!key.includes("*")) return undefined

	const head = target.slice(0, star)
	const tail = target.slice(star + 1)

	if (!packageRelative.startsWith(head) || !packageRelative.endsWith(tail)) return undefined

	if (packageRelative.length <= head.length + tail.length) return undefined

	return key.replace("*", packageRelative.slice(head.length, packageRelative.length - tail.length))
}

function packageRelativeTarget(manifest: PackageManifest, file: string): string | undefined {
	if (!file.startsWith(`${manifest.dir}/`)) return undefined

	return `./${file.slice(manifest.dir.length + 1)}`
}

/**
 * Every specifier that names `file` under `manifest`'s own maps, in map order.
 *
 * `file` is repo-relative and so is `manifest.dir`; a file outside the package answers nothing, which is how a caller
 * learns it asked the wrong package.
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
 * The relative specifier that reaches `target` from `containingFile`, both repo-relative.
 *
 * `keepExtension` mirrors what the specifier being replaced wrote. Source in this repository runs under Node's type
 * stripping, so a relative import carries an explicit `.ts`; a rewrite that dropped it would break the running form and
 * typecheck anyway.
 */
export function relativeSpecifier(containingFile: string, target: string, keepExtension: boolean): string {
	const path = String(relative(String(dirname(containingFile)), target))
	const bare = keepExtension ? path : path.replace(SOURCE_EXTENSION, "")

	return bare.startsWith(".") ? bare : `./${bare}`
}

/**
 * Whether a specifier writes its file extension, which decides the form a relative replacement takes.
 */
export function hasSourceExtension(specifier: string): boolean {
	return SOURCE_EXTENSION.test(specifier)
}

/**
 * Candidates ordered by how little they change: the one sharing the longest prefix with the specifier being replaced
 * comes first, and a shorter specifier wins a tie.
 *
 * Ordering decides which proven candidate is written, so it is the difference between `#recipes/fr/order` and a
 * technically-correct `#recipes/fr/order.ts` that no sibling line resembles.
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
