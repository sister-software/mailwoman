/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An arm that runs a DIFFERENT VERSION OF THE SOURCE, in its own process.
 *
 *   This is the half the staleness guard was missing. `tree-fingerprint.ts` correctly refuses to serve an
 *   engine whose modules predate the working tree, because Node's ESM cache has no invalidation — but a
 *   refusal with no alternative just moves the work outside the tool, and the thing a maintainer most often
 *   wants to measure IS a source change. Hand-rolling it means re-deriving the engine's own
 *   {@linkcode resolveConfig} defaults in a throwaway script, which is the shared-constants failure mode: the
 *   two arms drift and nothing says so.
 *
 *   So the arm is a git worktree plus a subprocess. One process cannot hold two versions of a module; two
 *   processes can, and the child imports the worktree's source because that is the only source on its
 *   resolution path.
 *
 *   THE NODE_MODULES TRAP, which is the whole reason this file is longer than a `spawn` call. A git worktree
 *   has no `node_modules`, and symlinking the main checkout's directory across does NOT work: yarn links a
 *   workspace as `node_modules/@mailwoman/core -> ../../packages/core`, resolved against the symlink's REAL
 *   path, so every `@mailwoman/*` import would silently land back in the main checkout and the child would
 *   measure exactly the code it was spawned to avoid. It would look like it worked. This builds a farm
 *   instead: third-party packages symlink across (they are identical and huge), and the workspaces whose
 *   source can change a geocode are re-pointed INTO the worktree.
 *
 *   ONLY those, and the exception is not cosmetic. The `neural-weights-*` workspaces ship `model.onnx` and
 *   `tokenizer.model`, which are NOT committed — they are materialized into the checkout from
 *   `$MAILWOMAN_DATA_ROOT` by each package's `link-dev-weights.ts`. Re-pointing them at a fresh worktree
 *   gives the child a weights package with no weights in it, and the failure is loud but misleading:
 *   "geocode requires the neural weights. Install @mailwoman/neural-weights-en-us". The list of workspaces
 *   worth re-pointing is exactly {@link FINGERPRINTED_WORKSPACES} — the same list the staleness guard uses,
 *   for the same reason, since "source that can change a geocode" is the one question both are asking.
 */

import { readDirectory, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, removePathIfPresent, writeLocalFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { execFileSync } from "@mailwoman/platform/child_process"
import { join } from "@mailwoman/platform/path"

import { FINGERPRINTED_WORKSPACES } from "./tree-fingerprint.ts"

/**
 * The `ref` that means "the working tree as it stands", uncommitted edits included.
 *
 * Spelled as a reserved word rather than accepted implicitly, because git resolves almost anything: without this, a
 * caller wanting their edits measured would pass `HEAD`, get a clean checkout of the last commit, and read a verdict
 * about code they had already changed.
 */
export const WORKING_TREE_REF = "WORKTREE"

/**
 * Written into whichever checkout the arm runs in — including, for {@link WORKING_TREE_REF}, the operator's own. Named
 * with a leading dot and removed in a `finally` so a crashed child cannot leave it in a tracked tree.
 */
const RUNNER_FILENAME = ".mwdev-arm-runner.ts"

/**
 * Where a workspace's package name maps to its directory, both read from the checkout being prepared.
 */
interface WorkspaceLink {
	packageName: string
	directory: string
}

/**
 * Read the root `workspaces` globs and resolve each to a `name -> directory` pair.
 *
 * Reads the WORKTREE's own manifests, not the main checkout's, because a ref that predates a workspace must not have
 * that workspace linked into it — an import that should fail at the older ref has to actually fail.
 */
async function workspaceLinks(root: string): Promise<WorkspaceLink[]> {
	const manifest = await readLocalJSONFile<{ workspaces?: string[] }>(join(root, "package.json"))
	const links: WorkspaceLink[] = []

	for (const entry of manifest.workspaces ?? []) {
		// The array holds literal paths in this repo, not globs. A glob would need expansion; treat a missing
		// manifest as "not a workspace at this ref" rather than an error, which is the same thing.
		let name: string

		try {
			name = (await readLocalJSONFile<{ name?: string }>(join(root, entry, "package.json"))).name ?? ""
		} catch {
			continue
		}

		if (name) {
			links.push({ packageName: name, directory: entry })
		}
	}

	return links
}

/**
 * Build `<worktree>/node_modules` as a symlink farm over the main checkout's, with every workspace re-pointed inward.
 *
 * Scoped directories are handled one level down when the scope contains a workspace, and whole otherwise: `@types` is
 * thousands of identical packages and is linked as one entry, while `@mailwoman` is rebuilt member by member.
 */
async function linkNodeModules(mainRoot: string, worktree: string): Promise<void> {
	const source = join(mainRoot, "node_modules")
	const target = join(worktree, "node_modules")
	const fingerprinted = new Set<string>(FINGERPRINTED_WORKSPACES)
	const links = (await workspaceLinks(worktree)).filter((link) => fingerprinted.has(link.directory))

	const workspaceByName = new Map(links.map((link) => [link.packageName, link.directory]))

	const scopesWithWorkspaces = new Set(
		links.map((link) => link.packageName).flatMap((name) => (name.startsWith("@") ? [name.split("/")[0]!] : []))
	)

	await makeDirectories(target)

	for (const entry of await readDirectory(source)) {
		if (scopesWithWorkspaces.has(entry)) {
			const scopeTarget = join(target, entry)

			await makeDirectories(scopeTarget)

			for (const member of await readDirectory(join(source, entry))) {
				const full = `${entry}/${member}`
				const workspace = workspaceByName.get(full)

				await createSymbolicLink(
					workspace ? join(worktree, workspace) : join(source, entry, member),
					join(scopeTarget, member)
				)
			}

			continue
		}

		const workspace = workspaceByName.get(entry)

		await createSymbolicLink(workspace ? join(worktree, workspace) : join(source, entry), join(target, entry))
	}
}

/**
 * The script the child runs, written INTO the worktree rather than committed.
 *
 * Written rather than committed on purpose: a committed runner would only exist at refs that already have it, so the
 * arm could not reach backwards past its own introduction — which is most of the refs anyone wants to compare against.
 * Its imports resolve inside the worktree, so it is the ref's pipeline that answers.
 *
 * It reads {@link ArmRequest} on stdin and writes {@link ArmResponse} on stdout, so nothing is passed by argv and an
 * input containing a quote or a newline cannot become a shell problem.
 */
const RUNNER_SOURCE = `
import { createGeocodeSession } from "mailwoman/geocode-session"

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
 * One answer from the child, in the shape the comparison's arm runner projects from.
 */
interface WorktreeAnswer {
	input: string
	lat: number | null
	lon: number | null
	tier: string | null
	components: Record<string, string>
	error?: string
}

export interface WorktreeArmResult {
	/**
	 * The commit the worktree was checked out at, resolved to a full sha so the result names a fixed tree rather than a
	 * moving ref.
	 */
	commit: string
	answers: WorktreeAnswer[]
	/**
	 * Wall-clock for worktree creation plus the symlink farm, kept separate from the run so a slow arm is attributable.
	 */
	setupMs: number
	runMs: number
}

/**
 * Run one input set through `ref`'s source, in a child process, and return its answers.
 *
 * `options` is the resolved {@linkcode GeocodeSessionOptions} the caller's own registry produced — passed through rather
 * than re-derived here, so both arms are configured by ONE function and a lever added to `resolveConfig` reaches this
 * arm without being copied into it.
 *
 * The worktree is removed in `finally`, including on a child crash. `git worktree add --detach` never moves the
 * caller's HEAD and never touches the working tree, so a comparison cannot disturb uncommitted work — which is the
 * property that makes this safe to run mid-edit, and the reason it is a worktree rather than a stash.
 */
export async function runWorktreeArm(args: {
	repoRoot: string
	ref: string
	inputs: readonly string[]
	options: Record<string, unknown>
	timeoutMs?: number
}): Promise<WorktreeArmResult> {
	const { repoRoot, ref, inputs, options } = args
	const setupStartedAt = Date.now()

	// The UNCOMMITTED working tree, which no git ref can name and which is the arm a maintainer reaches for most:
	// "what I have edited" against "what is committed". It needs no worktree and no farm — the main checkout
	// already has both — only its own process, which is the entire point. Spawning it through the SAME runner as a
	// ref arm is what keeps the comparison honest: one script, one config path, so a difference between the arms
	// is a difference in source rather than in how each side was invoked.
	const live = ref === WORKING_TREE_REF

	await using resources = new AsyncDisposableStack()

	// The working-tree arm owns nothing: it runs in the main checkout. A ref arm owns a scratch parent, and its
	// teardown is ordered: git releases the worktree, then the directory under it goes, then the prune clears the
	// admin entry for a directory that is now gone. The stack unwinds last-in, first-out, so registering in the
	// reverse of that order is what states it — prune first, so prune runs last.
	if (!live) {
		resources.defer(() => {
			execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe" })
		})
	}

	const parent = live ? undefined : resources.use(await temporaryDirectory("mwdev-worktree-"))
	const worktree = parent ? parent.resolve("checkout") : repoRoot

	if (!live) {
		execFileSync("git", ["worktree", "add", "--detach", worktree, ref], { cwd: repoRoot, stdio: "pipe" })

		// `git worktree remove` refuses on a dirty checkout, and this one always is — the runner script and the
		// node_modules farm are both untracked. `--force` is the normal path here, not an override.
		resources.defer(() => {
			try {
				execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot, stdio: "pipe" })
			} catch {
				// A failed removal must not mask the arm's own error; removing the parent directory and pruning
				// afterwards clean up regardless.
			}
		})
	}

	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim()

	const dirty = live
		? execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0
		: false

	// A dirty working tree is NOT its HEAD, and reporting the sha alone would let a comparison claim it ran
	// that commit when it ran that commit plus uncommitted edits.
	const commit = dirty ? `${head}+dirty` : head

	if (!live) {
		await linkNodeModules(repoRoot, worktree)
	}

	const runnerPath = join(worktree, RUNNER_FILENAME)

	await writeLocalFile(RUNNER_SOURCE, runnerPath)

	const setupMs = Date.now() - setupStartedAt
	const runStartedAt = Date.now()

	try {
		const stdout = execFileSync(process.execPath, [runnerPath], {
			cwd: worktree,
			input: JSON.stringify({ inputs, options }),
			encoding: "utf8",
			// A full board through a cold engine is minutes, and the payload is megabytes; both defaults are far
			// too small and both failures look like a crash rather than a limit.
			timeout: args.timeoutMs ?? 30 * 60 * 1000,
			maxBuffer: 512 * 1024 * 1024,
		})

		const parsed = parseJSONStrict<{ answers: WorktreeAnswer[] }>(stdout)

		return { commit, answers: parsed.answers, setupMs, runMs: Date.now() - runStartedAt }
	} finally {
		// The live arm runs IN the operator's checkout, so its runner is the one piece of litter a comparison
		// could leave in a tracked tree. Remove it on every path, including a child crash.
		if (live) {
			await removePathIfPresent(runnerPath)
		}
	}
}
