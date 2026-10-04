/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The half of a move that is not a module specifier: the `exports`/`imports` targets naming the file.
 *
 * A subpath key is an interface and stays exactly as written, while the target is a path that must be rewritten so a
 * file can move without a consumer noticing.
 *
 * One source file maps to up to three targets because a workspace narrows `rootDir` to `lib/` and emits to
 * `out/`, and every one has to move together. A root beside `lib/` emits to `out/<root>/`.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"

import type { ManifestRewrite } from "#repo-health/move/types"

const SOURCE_ROOTS = new Set(["lib", "src"])
/**
 * Roots beside `lib/` that compile as their own project and emit under `out/<root>/`.
 */
const EXTRA_SOURCE_ROOTS = new Set(["sdk", "tools", "cli"])
const SOURCE_EXTENSION = /\.tsx?$/u

function targetsFor(packageRelative: string): string[] {
	const targets = [`./${packageRelative}`]
	const [root, ...rest] = packageRelative.split("/")

	if (!root || !rest.length) return targets

	const emitted = rest.join("/").replace(SOURCE_EXTENSION, "")

	if (SOURCE_ROOTS.has(root)) {
		targets.push(`./out/${emitted}.js`, `./out/${emitted}.d.ts`)
	} else if (EXTRA_SOURCE_ROOTS.has(root)) {
		targets.push(`./out/${root}/${emitted}.js`, `./out/${root}/${emitted}.d.ts`)
	}

	return targets
}

interface ManifestMove {
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
 * Rewrites for one package's manifest, edited as text rather than reserialized
 * so key order and formatting survive.
 */
function manifestRewritesIn(file: string, text: string, moves: readonly ManifestMove[]): ManifestRewrite[] {
	const rewrites: ManifestRewrite[] = []

	for (const move of moves) {
		const from = targetsFor(move.from)
		const to = targetsFor(move.to)

		for (const [index, target] of from.entries()) {
			const replacement = to[index]

			if (!replacement) continue

			const quoted = stringifyJSON(target)

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
 * Every manifest target the moves invalidate, reading only the manifests a move lands in
 * because `packageDirectories` is already known to the caller.
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
