/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs geocodes against another version of the source, in a git worktree and a child process.
 *
 *   One Node process cannot load two versions of a module, so the child imports the worktree's source.
 *
 *   A git worktree has no `node_modules`. Symlinking the main checkout's directory would not work, because
 *   yarn's workspace links resolve back into the main checkout. This module builds a symlink farm instead:
 *   third-party packages link to the main checkout, and each workspace in {@link FINGERPRINTED_WORKSPACES}
 *   links into the worktree. Other workspaces, including `neural-weights-*`, keep their main-checkout links
 *   because their weight files are not committed.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, removePathIfPresent, writeLocalFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { runFileSync } from "@mailwoman/core/process"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { FINGERPRINTED_WORKSPACES } from "#tree-fingerprint"

/**
 * The `ref` value that selects the current working tree, including uncommitted edits.
 *
 * `HEAD` would select a clean checkout of the last commit, so the working tree needs its own value.
 */
export const WORKING_TREE_REF = "WORKTREE"

/**
 * The runner file written into the checkout the arm runs in.
 *
 * For {@link WORKING_TREE_REF} that checkout is the main one, so the file is removed in a `finally` block.
 */
const RUNNER_FILENAME = ".mwdev-arm-runner.ts"

/**
 * A workspace's package name and directory.
 */
interface WorkspaceLink {
	packageName: string
	directory: string
}

/**
 * Reads the workspace list from a checkout and returns each workspace's name and directory.
 *
 * It reads the worktree's own manifests, so a workspace that did not exist at the ref is not linked in.
 */
async function workspaceLinks(root: PathBuilder): Promise<WorkspaceLink[]> {
	const links: WorkspaceLink[] = []

	// A listed directory that does not exist at this ref is skipped.
	for (const directory of await readWorkspaceDirectories(root, { tolerateMissing: true })) {
		const manifestPath = root(directory, "package.json")
		const { name } = await readPackageJSON(manifestPath)

		if (!name) throw new Error(`${manifestPath} declares no name`)

		links.push({ packageName: name, directory })
	}

	return links
}

/**
 * Builds `<worktree>/node_modules` as a symlink farm over the main checkout's `node_modules`.
 *
 * Fingerprinted workspaces link into the worktree.
 * A scope directory that contains one of them, such as `@mailwoman`, is rebuilt member by member.
 * Every other entry, such as `@types`, is linked whole.
 */
async function linkNodeModules(mainRoot: PathBuilder, worktree: PathBuilder): Promise<void> {
	const source = mainRoot("node_modules")
	const target = worktree("node_modules")
	const fingerprinted = new Set<string>(FINGERPRINTED_WORKSPACES)
	const links = (await workspaceLinks(worktree)).filter((link) => fingerprinted.has(link.directory))

	const workspaceByName = new Map(links.map((link) => [link.packageName, link.directory]))

	const scopesWithWorkspaces = new Set(
		links.map((link) => link.packageName).flatMap((name) => (name.startsWith("@") ? [name.split("/")[0]!] : []))
	)

	await makeDirectories(target)

	for await (const entry of Globerator.from("*", { cwd: source, absolute: false, onlyFiles: false })) {
		if (scopesWithWorkspaces.has(entry)) {
			const scopeTarget = target(entry)

			await makeDirectories(scopeTarget)

			for await (const member of Globerator.from("*", {
				cwd: source(entry),
				absolute: false,
				onlyFiles: false,
			})) {
				const full = `${entry}/${member}`
				const workspace = workspaceByName.get(full)

				await createSymbolicLink(workspace ? worktree(workspace) : source(entry, member), scopeTarget(member))
			}

			continue
		}

		const workspace = workspaceByName.get(entry)

		await createSymbolicLink(workspace ? worktree(workspace) : source(entry), target(entry))
	}
}

/**
 * The script the child runs.
 *
 * The script is written at run time, so it also works at refs older than this module.
 * It reads one JSON request on stdin and writes the answers as JSON on stdout,
 * so inputs never pass through argv.
 */
const RUNNER_SOURCE = `
import { createGeocodeSession } from "mailwoman/geocode"

const request = JSON.parse(await new Response(process.stdin).text())
const session = await createGeocodeSession(request.options)
const answers = []

for (const input of request.inputs) {
	try {
		const { result } = await session.geocode(input)
		answers.push({ input, lat: result.lat, lon: result.lon, tier: result.resolution_tier, components: result.components })
	} catch (error) {
		answers.push({ input, lat: null, lon: null, tier: null, components: {}, error: String(error && error.message) })
	}
}

session[Symbol.dispose]()
process.stdout.write(JSON.stringify({ answers }))
`

/**
 * One answer from the child process.
 */
interface WorktreeAnswer {
	input: string
	lat: number | null
	lon: number | null
	tier: string | null
	components: Record<string, string>
	error?: string
}

/**
 * The answers from one worktree arm and its timings.
 */
export interface WorktreeArmResult {
	/**
	 * The full commit SHA the arm ran, with `+dirty` appended when the working tree had uncommitted changes.
	 */
	commit: string
	answers: WorktreeAnswer[]
	/**
	 * The time to create the worktree and the symlink farm, in milliseconds.
	 */
	setupMs: number
	runMs: number
}

/**
 * Runs inputs through `ref`'s source in a child process and returns the answers.
 *
 * `options` holds the session options that the caller's registry resolved,
 * so both arms share one configuration path.
 * `git worktree add --detach` leaves the caller's HEAD and working tree alone,
 * so this is safe to run during an edit.
 * The worktree is removed on every exit path.
 */
export async function runWorktreeArm(args: {
	repoRoot: PathBuilderLike
	ref: string
	inputs: readonly string[]
	options: Record<string, unknown>
	timeoutMs?: number
}): Promise<WorktreeArmResult> {
	const { ref, inputs, options } = args
	const repoRoot = PathBuilder.from(args.repoRoot)
	const setupStartedAt = Date.now()

	// The working-tree arm runs in the main checkout, which already has `node_modules`.
	// It still runs in a child process through the same runner, so both arms are invoked the same way.
	const live = ref === WORKING_TREE_REF

	await using resources = new AsyncDisposableStack()

	// Teardown must remove the worktree, then its parent directory, then prune git's entry.
	// The stack unwinds last-in, first-out, so the prune is registered first.
	if (!live) {
		resources.defer(() => {
			runFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe" })
		})
	}

	const parent = live ? undefined : resources.use(await temporaryDirectory("mwdev-worktree-"))
	const worktree = parent ? parent.path("checkout") : repoRoot

	if (!live) {
		runFileSync("git", ["worktree", "add", "--detach", worktree, ref], { cwd: repoRoot, stdio: "pipe" })

		// The runner and the symlink farm are untracked, so removal always needs `--force`.
		resources.defer(() => {
			try {
				runFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot, stdio: "pipe" })
			} catch {
				// A failed removal must not hide the arm's own error.
				// The parent removal and the prune still clean up.
			}
		})
	}

	const head = runFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim()

	const dirty = live
		? runFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0
		: false

	// The suffix records that the arm ran uncommitted edits on top of the commit.
	const commit = dirty ? `${head}+dirty` : head

	if (!live) {
		await linkNodeModules(repoRoot, worktree)
	}

	const runnerPath = worktree(RUNNER_FILENAME)

	await writeLocalFile(RUNNER_SOURCE, runnerPath)

	const setupMs = Date.now() - setupStartedAt
	const runStartedAt = Date.now()

	try {
		const stdout = runFileSync(process.execPath, [runnerPath], {
			cwd: worktree,
			input: stringifyJSON({ inputs, options }),
			encoding: "utf8",
			// A full board through a cold engine takes minutes and returns megabytes,
			// which exceed the default limits.
			timeout: args.timeoutMs ?? 30 * 60 * 1000,
			maxBuffer: 512 * 1024 * 1024,
		})

		const parsed = parseJSONStrict<{ answers: WorktreeAnswer[] }>(stdout)

		return { commit, answers: parsed.answers, setupMs, runMs: Date.now() - runStartedAt }
	} finally {
		// The working-tree arm wrote its runner into the main checkout, so it is removed on every path.
		if (live) {
			await removePathIfPresent(runnerPath)
		}
	}
}
