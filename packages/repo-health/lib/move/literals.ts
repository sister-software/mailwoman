/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The third thing a move invalidates: a repo-relative path written as TEXT.
 *
 *   A specifier is checked by the compiler and a manifest target by `manifest-targets`. A path inside a hook command,
 *   a Vale glob, a workflow step or a docstring's `Usage:` line is checked by nothing — it is read at runtime by
 *   something that treats absence as a NEGATIVE ANSWER rather than an error, which is why `AGENTS.md` prescribes a
 *   sweep for quoted workspace paths after every move. This module is that sweep, done by the operation that caused
 *   the problem.
 *
 *   Matching is by exact substring of the old path, so a glob keeps its shape: `lib/tools/sub-venue/*.ts` becomes
 *   `lib/tools/sub/venue/*.ts` because only the moved segment is replaced.
 *
 *   Dated records are exempt. A plan or a spec describes what was true on its date, and rewriting the paths inside it
 *   makes it describe a tree that never existed.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import type { ModuleMove, PathLiteralRewrite } from "#move/types"

/**
 * Point-in-time records, where a path is part of what the document reports rather than a reference to be kept true.
 */
export const DATED_RECORDS: readonly string[] = [
	"docs/superpowers/plans/",
	"docs/superpowers/specs/",
	"docs/records/evals/",
	"docs/records/retrospectives/",
]

/**
 * The directory renames a set of file moves implies.
 *
 * A config names a directory far more often than it names a file — `lib/tools/sub-venue/*.ts` is a glob, and no file
 * path is a substring of it. Trimming the segments the two ends share leaves exactly the part that moved.
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
 * The EMITTED paths a set of source moves implies, as a move of its own.
 *
 * A test spawns `packages/mailwoman/out/cli/index.js`, a workflow runs one, a docstring names one. None of those is the
 * source path, so a sweep over source paths alone leaves them naming an output `tsc` no longer produces — and `tsc -b`
 * does not delete the file it used to produce, so the stale one answers instead of failing.
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
 * Every occurrence of a moved path in one file's text.
 *
 * Longest path first, so a file naming both a moved directory and a moved file inside it does not have the shorter
 * match consume the longer one.
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
 * Every stale path literal the moves leave in the tracked tree, outside the moved files' own content and the dated
 * records.
 *
 * The moved files themselves ARE scanned: a `Usage:` line naming the script it sits in is the single most common
 * instance of this, and it goes stale the moment the file moves.
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
			// A binary or unreadable file holds no path literal anyone wrote.
			continue
		}

		rewrites.push(...pathLiteralsIn(read, text, needles))
	}

	return rewrites
}
