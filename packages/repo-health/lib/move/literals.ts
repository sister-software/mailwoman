/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Finds repo-relative paths written as plain text (hook commands, globs, workflow steps, `Usage:` lines) that a
 *   move makes stale.
 *
 *   The compiler and `manifest-targets` do not check these paths. Matching uses an exact substring of the old path, so
 *   only the moved segment of a glob changes.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import type { ModuleMove, PathLiteralRewrite } from "#move/types"

/**
 * Path prefixes of dated records, which the sweep leaves unchanged because their
 * paths describe the tree on their date.
 */
export const DATED_RECORDS: readonly string[] = [
	"docs/superpowers/plans/",
	"docs/superpowers/specs/",
	"docs/records/evals/",
	"docs/records/retrospectives/",
]

/**
 * Derives the directory renames implied by a set of file moves.
 *
 * Configs usually refer to directories or globs, which no moved file path matches as a substring.
 * The function trims the trailing segments that the old and new paths share,
 * leaving the directory part that moved.
 */
export function directoryMoves(moves: readonly ModuleMove[]): ModuleMove[] {
	const pairs = new Map<string, string>()

	for (const move of moves) {
		const from = move.from.split("/")
		const to = move.to.split("/")
		let head = from.length - 1
		let tail = to.length - 1

		while (head >= 0 && tail >= 0 && from[head] === to[tail]) {
			head--

			tail--
		}

		const fromDirectory = from.slice(0, head + 1).join("/")
		const toDirectory = to.slice(0, tail + 1).join("/")

		if (fromDirectory && toDirectory && fromDirectory !== toDirectory && fromDirectory !== move.from) {
			pairs.set(fromDirectory, toDirectory)
		}
	}

	return [...pairs].map(([from, to]) => ({ from, to }))
}

const SOURCE_ROOT = /\/(lib|src)\//u
const SOURCE_EXTENSION = /\.tsx?$/u

/**
 * Derives the moves of the `.js`, `.d.ts` and `.js.map` outputs for each moved `lib/`
 * or `src/` TypeScript source.
 *
 * Tests, workflows and docstrings refer to `out/` paths, and a sweep over
 * source paths alone would miss them.
 */
export function emittedMoves(moves: readonly ModuleMove[]): ModuleMove[] {
	const emitted: ModuleMove[] = []

	for (const move of moves) {
		if (!SOURCE_ROOT.test(move.from) || !SOURCE_ROOT.test(move.to)) continue

		if (!SOURCE_EXTENSION.test(move.from)) continue

		for (const extension of [".js", ".d.ts", ".js.map"]) {
			emitted.push({
				from: move.from.replace(SOURCE_ROOT, "/out/").replace(SOURCE_EXTENSION, extension),
				to: move.to.replace(SOURCE_ROOT, "/out/").replace(SOURCE_EXTENSION, extension),
			})
		}
	}

	return emitted
}

/**
 * Finds every occurrence of a moved path in one file's text, ordered by offset.
 *
 * Longer paths claim their spans first, so a moved file inside a moved directory is rewritten as a whole.
 */
export function pathLiteralsIn(file: string, text: string, moves: readonly ModuleMove[]): PathLiteralRewrite[] {
	const rewrites: PathLiteralRewrite[] = []
	const ordered = [...moves].toSorted((a, b) => b.from.length - a.from.length)
	const claimed: Array<[number, number]> = []

	for (const move of ordered) {
		for (let at = text.indexOf(move.from); at !== -1; at = text.indexOf(move.from, at + 1)) {
			const end = at + move.from.length

			if (claimed.some(([start, stop]) => at < stop && start < end)) continue

			claimed.push([at, end])
			rewrites.push({ file, path: move.from, replacement: move.to, start: at, end })
		}
	}

	return rewrites.toSorted((a, b) => a.start - b.start)
}

/**
 * Finds every stale path literal the moves leave in the tracked files,
 * skipping `out/` and the `exempt` prefixes.
 *
 * Moved files are read from their destination and scanned too, because a script's
 * `Usage:` line often quotes its own path.
 */
export async function planPathLiteralRewrites(
	repoRoot: string,
	trackedFiles: readonly string[],
	moves: readonly ModuleMove[],
	exempt: readonly string[] = DATED_RECORDS
): Promise<PathLiteralRewrite[]> {
	const destinations = new Map(moves.map((move) => [move.from, move.to]))
	const needles = [...moves, ...emittedMoves(moves), ...directoryMoves(moves)]
	const rewrites: PathLiteralRewrite[] = []

	for (const file of trackedFiles) {
		if (file.includes("/out/") || exempt.some((prefix) => file.startsWith(prefix))) continue

		const read = destinations.get(file) ?? file
		let text: string

		try {
			text = await readLocalTextFile(resolvePath(repoRoot, read))
		} catch {
			// The sweep skips binary and unreadable files.
			continue
		}

		rewrites.push(...pathLiteralsIn(read, text, needles))
	}

	return rewrites
}
