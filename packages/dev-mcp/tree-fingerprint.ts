/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The staleness guard for a long-lived process holding an imported module graph.
 *
 *   A warm engine is warm because Node already evaluated its modules. Node's ESM cache has no invalidation, so a source
 *   edit is invisible to a process that already imported it: the agent edits `geocode-core.ts`, calls a tool, and reads
 *   an answer produced by the code it just replaced. Nothing errors. This is the same shape as the stale-`out/` trap
 *   (`corpus-stamp.ts` records the 2026-08-06 instance, where a build printed "built", exited 0, and every gate
 *   afterwards graded a corpus nobody had) with one difference that matters: that trap already existed, and this one is
 *   manufactured by the decision to hold state at all.
 *
 *   So it is answered rather than accepted. The fingerprint covers the newest mtime across the workspaces an engine
 *   imports, plus `HEAD` and the dirty set, and a change makes the engine UNREACHABLE rather than wrong.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Workspaces whose source an engine's module graph reaches. Editing anything here can change a parse or a resolve, so
 * an edit invalidates every resident engine.
 *
 * Deliberately a list rather than "every workspace": a docs or a `bdc` edit cannot change a geocode, and treating it as
 * though it could would evict engines on every unrelated commit — which trains the operator to ignore the signal.
 */
export const FINGERPRINTED_WORKSPACES = [
	"packages/mailwoman",
	"packages/core",
	"packages/neural",
	"packages/resolver",
	"packages/resolver-wof-sqlite",
	"packages/normalize",
	"packages/query-shape",
	"packages/locale-gate",
	"packages/kind-classifier",
	"packages/phrase-grouper",
	"packages/codex",
] as const

/**
 * Directory names that never affect behaviour but change constantly. `out/` is excluded on purpose and is the important
 * one: the daemon imports SOURCE, so a recompile must not read as a source edit.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", "out", ".git", "test", "__pycache__"])

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".json"]

export interface TreeFingerprint {
	/**
	 * The hash callers compare. Opaque; only equality is meaningful.
	 */
	digest: string
	gitHead: string
	/**
	 * Paths with uncommitted changes, as `git status --porcelain` reports them. A dirty tree is normal during development
	 * — this is carried so a result can say which files were uncommitted when it was produced, not to refuse.
	 */
	dirtyFiles: string[]
	/**
	 * Newest source mtime found, in epoch milliseconds. Reported so a human can tell "I edited something" from "I
	 * switched branches" when a fingerprint moves.
	 */
	newestMtimeMs: number
	newestPath: string | null
	/**
	 * Source files walked. A zero here would mean the walk found nothing and every fingerprint would agree with every
	 * other — the emptiness failure `corpus-stamp.ts` names ("an empty loader on BOTH sides agrees with itself"), so
	 * {@link computeTreeFingerprint} throws rather than returning it.
	 */
	filesWalked: number
}

function newestSourceMtime(root: string): { mtimeMs: number; path: string | null; count: number } {
	let newest = 0
	let newestPath: string | null = null
	let count = 0
	const stack = [root]

	while (stack.length) {
		const dir = stack.pop()!
		let entries

		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			// A workspace that does not exist in this checkout contributes nothing rather than throwing — the caller's
			// emptiness check is what catches a list that is wrong in total.
			continue
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) {
					stack.push(join(dir, entry.name))
				}

				continue
			}

			if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue

			count++

			const full = join(dir, entry.name)
			const { mtimeMs } = statSync(full)

			if (mtimeMs > newest) {
				newest = mtimeMs
				newestPath = full
			}
		}
	}

	return { mtimeMs: newest, path: newestPath, count }
}

function git(repoRoot: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
	} catch {
		return ""
	}
}

/**
 * Fingerprint the source an engine depends on.
 *
 * @throws If the walk found no source files at all — see {@link TreeFingerprint.filesWalked}.
 */
export function computeTreeFingerprint(repoRoot: string): TreeFingerprint {
	let newestMtimeMs = 0
	let newestPath: string | null = null
	let filesWalked = 0

	for (const workspace of FINGERPRINTED_WORKSPACES) {
		const result = newestSourceMtime(join(repoRoot, workspace))

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

	const gitHead = git(repoRoot, ["rev-parse", "HEAD"])
	const status = git(repoRoot, ["status", "--porcelain"])
	// `git status --porcelain` over one checkout, already fully buffered by execFileSync above: there is no stream to
	// consume lazily, and the bound is the number of changed files in a working tree.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, already in memory
	const dirtyFiles = status ? status.split("\n").map((line) => line.slice(3).trim()) : []

	const digest = createHash("sha256")
		.update(`${gitHead}\n${newestMtimeMs}\n${filesWalked}\n${dirtyFiles.join("\n")}`)
		.digest("hex")
		.slice(0, 16)

	return { digest, gitHead, dirtyFiles, newestMtimeMs, newestPath, filesWalked }
}

/**
 * The message a tool returns when its engine predates the current source.
 *
 * The remedy is a restart rather than a reload because there is no reliable in-process reload: Node cannot drop a
 * module from its ESM cache, so an "already reloaded" claim would be false. Saying so plainly beats serving an answer
 * from code the operator has replaced.
 */
export function staleEngineMessage(engineFingerprint: TreeFingerprint, current: TreeFingerprint): string {
	const changed = current.newestPath ? ` Newest source: ${current.newestPath}.` : ""

	return (
		`Engine was built against tree ${engineFingerprint.digest}; the working tree is now ${current.digest}.` +
		`${changed} Node cannot evict an imported module, so this engine can only serve the old code. ` +
		`Restart the MCP server (or call mwdev_daemon with action "reload") and re-run.`
	)
}
