/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Finds repo-relative paths written as plain text (hook commands, globs, workflow steps, `Usage:` lines) that a
 *   move makes stale.
 *
 *   The compiler and `manifest-targets` do not check these paths. The matcher uses an exact substring of the old path, so
 *   only the moved segment of a glob changes.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isSymbolicLink, pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePath } from "path-ts"

import type { ModuleMove, PathLiteralRewrite } from "#repo-health/move/types"

/**
 * Path prefixes of dated records.
 *
 * The sweep leaves them unchanged because their paths describe the tree as it existed on their date.
 */
const DATED_RECORDS: readonly string[] = [
	"docs/superpowers/plans/",
	"docs/superpowers/specs/",
	"docs/records/evals/",
	"docs/records/retrospectives/",
]

/**
 * A preregistration freeze or an evaluation receipt.
 * It records the paths it was written against.
 */
const RECORD_FILE = /-(?:freeze|receipt)\.json$/u

/**
 * Derives the directory renames implied by a set of file moves.
 *
 * Configs refer to directories or globs.
 * No moved file path matches them as a substring.
 *
 * Each move proposes one candidate per trailing segment the old and new paths share:
 * `lib/eval/cases/x.jsonl` → `tools/eval/cases/x.jsonl` proposes `lib/eval/cases`, `lib/eval` and `lib`.
 * A candidate counts only when every tracked file under the old directory moves to the same path
 * under the new one, so a single file leaving a directory keeps the directory's own paths unchanged.
 */
export function directoryMoves(moves: readonly ModuleMove[], trackedFiles: readonly string[]): ModuleMove[] {
	const destinations = new Map(moves.map((move) => [move.from, move.to]))
	const checked = new Map<string, boolean>()

	const wholeDirectoryMoves = (from: string, to: string): boolean => {
		const key = `${from}\0${to}`
		const known = checked.get(key)

		if (known !== undefined) return known

		const whole = trackedFiles
			.filter((file) => file.startsWith(`${from}/`))
			.every((file) => destinations.get(file) === `${to}${file.slice(from.length)}`)

		checked.set(key, whole)

		return whole
	}

	const pairs = new Map<string, string>()

	for (const move of moves) {
		const from = move.from.split("/")
		const to = move.to.split("/")
		let head = from.length - 1
		let tail = to.length - 1

		while (head > 0 && tail > 0 && from[head] === to[tail]) {
			head--

			tail--

			const fromDirectory = from.slice(0, head + 1).join("/")
			const toDirectory = to.slice(0, tail + 1).join("/")

			if (fromDirectory !== toDirectory && wholeDirectoryMoves(fromDirectory, toDirectory)) {
				pairs.set(fromDirectory, toDirectory)
			}
		}
	}

	return [...pairs].map(([from, to]) => ({ from, to }))
}

const SOURCE_ROOT = /\/(lib|src)\//u
const EXTRA_SOURCE_ROOT = /^(packages\/[^/]+)\/(sdk|tools|cli)\//u
const SOURCE_EXTENSION = /\.tsx?$/u

/**
 * The emitted path of a TypeScript source without its extension, or `undefined` outside a source root.
 *
 * `lib/` and `src/` emit to `out/`.
 * A root beside `lib/` (`sdk/`, `tools/`, `cli/`) emits to `out/<root>/`.
 */
function emittedStem(path: string): string | null {
	if (!SOURCE_EXTENSION.test(path)) return null

	if (EXTRA_SOURCE_ROOT.test(path)) return path.replace(EXTRA_SOURCE_ROOT, "$1/out/$2/").replace(SOURCE_EXTENSION, "")

	if (SOURCE_ROOT.test(path)) return path.replace(SOURCE_ROOT, "/out/").replace(SOURCE_EXTENSION, "")

	return null
}

/**
 * Derives the moves of the `.js`, `.d.ts` and `.js.map` outputs for each moved TypeScript source.
 *
 * Tests and workflows refer to `out/` paths.
 * Docstrings refer to them too.
 *
 * A sweep over source paths by themselves would miss these references.
 */
export function emittedMoves(moves: readonly ModuleMove[]): ModuleMove[] {
	const emitted: ModuleMove[] = []

	for (const move of moves) {
		const from = emittedStem(move.from)
		const to = emittedStem(move.to)

		if (!from || !to) continue

		for (const extension of [".js", ".d.ts", ".js.map"]) {
			emitted.push({ from: `${from}${extension}`, to: `${to}${extension}` })
		}
	}

	return emitted
}

/**
 * Finds every occurrence of a moved path in one file's text, ordered by offset.
 *
 * Longer paths claim their spans first, so a moved file inside a moved directory is rewritten as a whole.
 */
function pathLiteralsIn(file: string, text: string, moves: readonly ModuleMove[]): PathLiteralRewrite[] {
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
 * Moved files are scanned too, because a script's `Usage:` line often quotes its own path.
 * A moved file is read wherever it is on disk, at its source before the move is applied
 * or at its destination after.
 *
 * Its rewrites point at the destination, where the applier edits it.
 */
export async function planPathLiteralRewrites(
	repoRoot: string,
	trackedFiles: readonly string[],
	moves: readonly ModuleMove[],
	exempt: readonly string[] = DATED_RECORDS
): Promise<PathLiteralRewrite[]> {
	const destinations = new Map(moves.map((move) => [move.from, move.to]))
	const needles = [...moves, ...emittedMoves(moves), ...directoryMoves(moves, trackedFiles)]
	const rewrites: PathLiteralRewrite[] = []

	for (const file of trackedFiles) {
		if (file.includes("/out/") || exempt.some((prefix) => file.startsWith(prefix)) || RECORD_FILE.test(file)) continue

		const destination = destinations.get(file) ?? file
		const location = (await pathExists(resolvePath(repoRoot, file))) ? file : destination

		// A tracked symlink shares its text with the file it points at.
		// This loop reads that file under its own path.
		// Edits for both would splice one file twice.
		if (await isSymbolicLink(resolvePath(repoRoot, location))) continue

		let text: string

		try {
			text = await readLocalTextFile(resolvePath(repoRoot, location))
		} catch {
			// The sweep skips binary and unreadable files.
			continue
		}

		rewrites.push(...pathLiteralsIn(destination, text, needles))
	}

	return rewrites
}
