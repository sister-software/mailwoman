/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The staleness guard for a long-lived process holding an imported module graph: the fingerprint covers the newest
 * mtime across the workspaces an engine imports, plus `head` and the dirty set, and a change makes the engine
 * unreachable rather than wrong.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { runFileSync } from "@mailwoman/core/process"
import { type PathBuilder, resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * Workspaces whose source an engine's module graph reaches, so an edit here invalidates every
 * resident engine; deliberately a list rather than "every workspace", because a docs edit cannot
 * change a geocode and evicting on unrelated commits trains the operator to ignore the signal.
 */
export const FINGERPRINTED_WORKSPACES = [
	"packages/mailwoman",
	"packages/core",
	"packages/neural",
	"packages/resolver",
	"packages/resolver-wof-sqlite",
	"packages/normalize",
	"packages/query-shape",
	"packages/locale-hint",
	"packages/kind-classifier",
	"packages/phrase-grouper",
	"packages/codex",
] as const

/**
 * Directory names that never affect behaviour but change constantly; `out/` is excluded on
 * purpose because the daemon imports source, so a recompile must not read as a source edit.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", "out", ".git", "test", "__pycache__"])

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".json"]

/**
 * A snapshot of the source an engine depends on, taken so a stale process is detected rather than trusted.
 */
export interface TreeFingerprint {
	/**
	 * The hash callers compare; opaque, so only equality is meaningful.
	 */
	digest: string
	gitHead: string
	/**
	 * Paths with uncommitted changes, as `git status --porcelain` reports them, carried
	 * so a result can say which files were uncommitted when it was produced rather than to refuse.
	 */
	dirtyFiles: string[]
	/**
	 * Newest source mtime found, in epoch milliseconds, reported so a human can tell "I
	 * edited something" from "I switched branches" when a fingerprint moves.
	 */
	newestMtimeMs: number
	newestPath: string | null
	/**
	 * Source files walked; a zero would mean the walk found no source file and every fingerprint would
	 * agree with every other, so {@link computeTreeFingerprint} throws rather than returning it.
	 */
	filesWalked: number
}

async function newestSourceMtime(root: PathBuilder): Promise<{ mtimeMs: number; path: string | null; count: number }> {
	let newest = 0
	let newestPath: string | null = null
	let count = 0
	const stack = [root]

	while (stack.length) {
		const dir = stack.pop()!
		let entries

		try {
			entries = await Globerator.from("*", { cwd: dir, withFileTypes: true, onlyFiles: false }).toArray()
		} catch {
			// A workspace absent from this checkout contributes no file rather than throwing;
			// the caller's emptiness check catches a list that is wrong in total.
			continue
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) {
					stack.push(dir(entry.name))
				}

				continue
			}

			if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue

			count++

			const full = dir(entry.name)
			const { mtimeMs } = await statPath(full)

			if (mtimeMs > newest) {
				newest = mtimeMs
				newestPath = full.toString()
			}
		}
	}

	return { mtimeMs: newest, path: newestPath, count }
}

/**
 * Run git and return its stdout with only the trailing newline removed, because `--porcelain`
 * needs its leading whitespace: a full trim eats column one of the first line only, after
 * which a fixed-width `slice(3)` takes the first character of the path with it.
 */
function git(repoRoot: PathBuilderLike, args: string[]): string {
	try {
		return runFileSync("git", args, { cwd: resolvePath(repoRoot), encoding: "utf8" }).replace(/\n+$/, "")
	} catch {
		return ""
	}
}

/**
 * Fingerprint the source an engine depends on.
 *
 * @throws If the walk found no source files at all — see {@link TreeFingerprint.filesWalked}.
 */
export async function computeTreeFingerprint(repoRoot: PathBuilderLike): Promise<TreeFingerprint> {
	let newestMtimeMs = 0
	let newestPath: string | null = null
	let filesWalked = 0

	for (const workspace of FINGERPRINTED_WORKSPACES) {
		const result = await newestSourceMtime(resolvePathBuilder(repoRoot, workspace))

		filesWalked += result.count

		if (result.mtimeMs > newestMtimeMs) {
			newestMtimeMs = result.mtimeMs
			newestPath = result.path
		}
	}

	if (filesWalked === 0) {
		throw new Error(
			`tree fingerprint: walked 0 source files under ${repoRoot}. ` +
				`A fingerprint over nothing matches every other fingerprint over nothing, which would silently disable ` +
				`the staleness guard rather than report it.`
		)
	}

	const gitHead = git(repoRoot, ["rev-parse", "HEAD"]).trim()
	const status = git(repoRoot, ["status", "--porcelain"])
	// `git status --porcelain` over one checkout is already fully buffered by execFileSync above, so there is no stream
	// to consume lazily and the bound is the number of changed files in a working tree.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, already in memory
	const dirtyFiles = status ? status.split("\n").map((line) => line.slice(3).trim()) : []

	const digest = sha256Hex(`${gitHead}\n${newestMtimeMs}\n${filesWalked}\n${dirtyFiles.join("\n")}`).slice(0, 16)

	return { digest, gitHead, dirtyFiles, newestMtimeMs, newestPath, filesWalked }
}

/**
 * The message a tool returns when the process's imported modules predate the current source:
 * restarting the process is the only permitted response and this message must not offer another,
 * because Node cannot evict an imported module and an in-process reload would report the new
 * fingerprint over the old code; to A/B a source change, run each arm in its own process.
 */
export function staleEngineMessage(engineFingerprint: TreeFingerprint, current: TreeFingerprint): string {
	const changed = current.newestPath ? ` Newest source: ${current.newestPath}.` : ""

	return (
		`This process imported tree ${engineFingerprint.digest}; the working tree is now ${current.digest}.` +
		`${changed} Node cannot evict an imported module, so this process can only serve the old code. ` +
		"Call `mwdev_restart` and re-run — it re-forks the worker with a fresh module graph; `reload` cannot help, " +
		"because it rebuilds sessions around the same already-imported modules. To compare a source change, run each " +
		"arm in a separate process."
	)
}
