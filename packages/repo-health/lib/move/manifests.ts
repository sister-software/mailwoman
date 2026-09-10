/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The half of a move that is not a module specifier: the `exports`/`imports` TARGETS naming the file.
 *
 *   A subpath key is a contract and stays exactly as written — `@mailwoman/geocode-oracle/sdk/census-client` keeps
 *   its name whatever the file underneath is called. The target does not: it is a path, and a path that has moved
 *   names nothing. Rewriting the target and leaving the key is what lets a file move without a consumer noticing.
 *
 *   Each target is generated from the move rather than searched for, so a string is replaced only where it is exactly
 *   the path this file computes. A workspace narrows `rootDir` to `lib/` and emits to `out/`, so one source file is
 *   named by up to three targets — `./lib/a/b.ts`, `./out/a/b.js`, `./out/a/b.d.ts` — and every one of them has to
 *   move together or `manifest-targets` reports the survivors.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import type { ManifestRewrite } from "#move/types"

const SOURCE_ROOTS = new Set(["lib", "src"])
const SOURCE_EXTENSION = /\.tsx?$/u

/**
 * Every manifest target that can name `packageRelative`, in the order a manifest lists them.
 */
function targetsFor(packageRelative: string): string[] {
	const targets = [`./${packageRelative}`]
	const [root, ...rest] = packageRelative.split("/")

	if (root && SOURCE_ROOTS.has(root) && rest.length) {
		const emitted = rest.join("/").replace(SOURCE_EXTENSION, "")

		targets.push(`./out/${emitted}.js`, `./out/${emitted}.d.ts`)
	}

	return targets
}

export interface ManifestMove {
	/**
	 * The package directory holding both ends of the move, repo-relative.
	 */
	packageDirectory: string
	/**
	 * Path within the package, without a leading `./`.
	 */
	from: string
	to: string
}

/**
 * Rewrites for one package's manifest, given every move landing inside that package.
 *
 * The manifest is edited as TEXT rather than reserialized: a `package.json` carries key order and formatting the
 * repository's own tooling compares, and a round-trip through `JSON.parse` rewrites the whole file to change one
 * string.
 */
export function manifestRewritesIn(file: string, text: string, moves: readonly ManifestMove[]): ManifestRewrite[] {
	const rewrites: ManifestRewrite[] = []

	for (const move of moves) {
		const from = targetsFor(move.from)
		const to = targetsFor(move.to)

		for (const [index, target] of from.entries()) {
			const replacement = to[index]

			if (!replacement) continue

			const quoted = JSON.stringify(target)

			for (let at = text.indexOf(quoted); at !== -1; at = text.indexOf(quoted, at + 1)) {
				rewrites.push({
					file,
					target,
					replacement,
					start: at,
					end: at + quoted.length,
				})
			}
		}
	}

	return rewrites.toSorted((a, b) => a.start - b.start)
}

/**
 * Every manifest target the moves invalidate, across each package that owns one of them.
 *
 * `packageDirectories` is the set a caller already knows — every tracked `package.json`'s directory — so this reads
 * only the manifests a move actually lands in.
 */
export async function planManifestRewrites(
	repoRoot: string,
	packageDirectories: readonly string[],
	moves: readonly { from: string; to: string }[]
): Promise<ManifestRewrite[]> {
	const byPackage = new Map<string, ManifestMove[]>()

	for (const move of moves) {
		const owner = packageDirectories
			.filter((directory) => move.from.startsWith(`${directory}/`))
			.toSorted((a, b) => b.length - a.length)[0]

		if (!owner || !move.to.startsWith(`${owner}/`)) continue

		byPackage.set(owner, [
			...(byPackage.get(owner) ?? []),
			{
				packageDirectory: owner,
				from: move.from.slice(owner.length + 1),
				to: move.to.slice(owner.length + 1),
			},
		])
	}

	const rewrites: ManifestRewrite[] = []

	for (const [directory, packageMoves] of byPackage) {
		const file = `${directory}/package.json`
		const text = await readLocalTextFile(resolvePath(repoRoot, file))

		rewrites.push(...manifestRewritesIn(file, text, packageMoves))
	}

	return rewrites
}
