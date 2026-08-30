/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Guard for the node_modules reach-around (2026-08-06 triage).
 *
 *   The defect this catches: hand-assembling a path INTO another package's install directory —
 *   `resolve(root, "node_modules/@mailwoman/neural-weights-en-us/model.onnx")` — instead of asking
 *   Node where that package lives (`import.meta.resolve`, `createRequire().resolve`) or exposing the
 *   file through an `exports` subpath. The assembled literal encodes a layout its owner never agreed
 *   to: it survives a package moving, a scope rename, a hoist, and a `files` change by silently
 *   pointing at nothing, and the caller reads that as "the artifact is missing" rather than "I looked
 *   in the wrong place". The promotion gate carried three of these and graded a bundle by a path no
 *   resolver had ever confirmed.
 *
 *   WHY THIS AND NOT A BLANKET `node:path` BAN. The 2026-08-06 survey counted 1,095 `join`/`resolve`
 *   call sites across 244 files, and the great majority are the right tool: CLI `--out` flags,
 *   `mkdtemp` scratch dirs, walking a user-supplied tree, composing under a root a caller passed in.
 *   Banning the import would flag 1,075 correct lines to catch 20. This guard is keyed on the ONE
 *   substring that separates the classes — a `node_modules` segment inside a path-building call — so
 *   a false positive is a real design question every time, and the allowlist stays short enough to
 *   read.
 *
 *   Scoped to `join`/`resolve` ARGUMENTS via the TypeScript AST rather than a grep, because
 *   `node_modules` appears legitimately (and constantly) in vitest exclude globs, `.gitignore`-shaped
 *   arrays, and prose. Source-parsing over importing follows `command-option-collisions.test.ts`: no
 *   module-resolution surface, nothing an alias-table change can break. Files are prefiltered on the
 *   substring first, so the AST cost is paid on ~30 files, not ~2,700.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/utils"
import { execFile } from "@mailwoman/platform/child_process"
import { join, relative } from "@mailwoman/platform/path"
import { promisify } from "@mailwoman/platform/util"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const execFileAsync = promisify(execFile)

const REPO_ROOT = repoRootPath()

/**
 * The path-building functions this guard watches: `node:path`'s two composers and path-ts's, in bare or `path.`-
 * qualified form (the callee NAME is what's matched, so `path.posix.join(…)` lands on `join`).
 *
 * The check is on the name alone, so a rename-import (`join as pathJoin`) slips past. That is the accepted hole: it has
 * no instances today, and closing it would mean resolving imports — the surface this file deliberately does without.
 */
const PATH_BUILDERS = new Set(["join", "resolve", "resolvePath", "resolvePathBuilder"])

/**
 * Every site allowed to spell a `node_modules` path by hand, with the reason it is not a reach-around. Keyed by
 * repo-relative path; add an entry only with a comment that survives review.
 */
const ALLOWED: Record<string, string> = {
	// THE ONE HOME. `weightsCachePackageDir` is the inverse of a resolution, not a substitute for one: the directory
	// does not exist yet when the layout is needed (`npm install --prefix <cacheRoot>` is about to create it, or
	// `stage-weights-cache.ts` is about to write a candidate bundle into it), so there is nothing to resolve. Every
	// other site in the tree now calls this.
	"packages/neural/weights.ts": "weightsCachePackageDir — the single home for the npm-prefix cache layout",
	// The ORACLE for that layout. A fixture built with the implementation's own helper cannot fail when the
	// implementation is wrong, so this file spells the path out independently and ties the helper back to it.
	"packages/neural/test/integration/weights-cache.test.ts":
		"pins the cache layout independently of the helper that builds it",
	// Probes a FOREIGN scratch project it just created with `npm install`. The whole point is to read the install
	// layout from outside; `import.meta.resolve` would answer from the monorepo's graph — the exact thing the clean-
	// install smoke exists to NOT consult.
	"scripts/smoke-clean-install.ts": "inspects a scratch project's install layout from outside, by design",
	// BUILDS a node_modules tree rather than reading one — the symlink farm a worktree arm needs, because a git
	// worktree has none and symlinking the main checkout's directory across resolves every workspace back into the
	// main checkout (yarn links `@mailwoman/core -> ../../packages/core`, resolved against the symlink's REAL path).
	// There is nothing to resolve: the directory does not exist until this code creates it.
	"packages/dev-mcp/worktree-arm.ts": "constructs the worktree's node_modules farm; nothing exists to resolve yet",
	// The ORACLE for that farm, on the same principle as the weights-cache pair above: a fixture built with the
	// implementation's own helper cannot fail when the implementation is wrong.
	"packages/dev-mcp/test/unit/worktree-arm.test.ts": "pins the farm layout independently of the code that builds it",
	// Writes a FIXTURE cache in the npm-prefix layout `weightsCachePackageDir` reads. Spelling it out here is what
	// makes the cache rung's test independent of the helper it is exercising.
	"packages/neural/test/integration/weights-overlay.test.ts":
		"builds a fixture cache in the npm-prefix layout, independently",
	// LINKS the checkout's node_modules into the staging tree rather than reading a package's layout — `yarn pack`
	// needs the project context there, and the link target is the checkout root's own directory, not another
	// package's install dir. Same principle as worktree-arm: nothing package-owned is being addressed by hand.
	"scripts/release-stage.ts": "symlinks the checkout's node_modules into the staging tree; not a package lookup",
}

/**
 * Every `.ts`/`.tsx` under the repo that is ours, prefiltered to the ones whose source mentions `node_modules` at all.
 *
 * "Ours" is the set of files git TRACKS, not everything on disk. A directory walk cannot tell our source from a
 * working-tree artifact, and it kept flagging files no reviewer would ever see: `scratchpad/` (git-ignored by
 * `scripts/AGENTS.md`'s design — the sanctioned home for one-off investigations), agent worktrees, and anything else a
 * local run happens to leave lying around. Such a hit fails the run for whoever has the file and CANNOT fail in CI,
 * which is the worst shape a guard can take — it reads as a real violation and is unreproducible by the person asked to
 * fix it. `git ls-files` answers the actual question, and drops the hand-maintained skip list with it: build output,
 * `node_modules`, `.yarn` and the rest are already ignored.
 */
async function listCandidateSources(): Promise<string[]> {
	const { stdout } = await execFileAsync("git", ["ls-files", "-z", "*.ts", "*.tsx"], {
		cwd: REPO_ROOT,
		maxBuffer: 32 * 1024 * 1024,
	})

	const tracked = stdout
		.split("\0")
		.filter((name) => name && !name.endsWith(".d.ts"))
		.map((name) => join(REPO_ROOT, name))

	const found = await Promise.all(
		tracked.map(async (path) => {
			if (!(await pathExists(path))) return null

			return (await readLocalTextFile(path)).includes("node_modules") ? path : null
		})
	)

	return found.filter((path): path is string => path !== null).toSorted()
}

/**
 * The `node_modules`-bearing string arguments of every path-building call in one source file.
 *
 * Both literal forms count: a plain string and a template literal (`` `node_modules/${scope}/${name}` ``), since the
 * interpolated form is the one a "make it dynamic" refactor reaches for first.
 */
function findReachArounds(source: string, fileName: string): string[] {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
	const hits: string[] = []

	const argumentText = (node: ts.Node): string | undefined => {
		// `isStringLiteralLike` already covers a no-substitution template.
		if (ts.isStringLiteralLike(node)) return node.text

		// An interpolated template: splice the literal chunks together with a SPACE standing in for each `${…}` (a
		// space cannot be a path separator, so it can never manufacture a segment boundary that isn't there). The
		// segment test below then sees `node_modules/ / ` instead of the raw source — which begins with a backtick,
		// and so could never match the leading-segment anchor. That was the bug the first draft of this guard shipped,
		// caught by probing it against the four shapes the triage had just removed.
		if (ts.isTemplateExpression(node)) {
			return node.head.text + node.templateSpans.map((span) => ` ${span.literal.text}`).join("")
		}

		return undefined
	}

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = ts.isPropertyAccessExpression(node.expression)
				? node.expression.name.text
				: ts.isIdentifier(node.expression)
					? node.expression.text
					: undefined

			if (callee && PATH_BUILDERS.has(callee)) {
				for (const argument of node.arguments) {
					const text = argumentText(argument)

					// A `node_modules` PATH SEGMENT, not the bare word — this must not fire on an exclude glob
					// like `**/node_modules/**` that happens to sit inside a `join`.
					if (text && /(^|[/\\])node_modules([/\\]|$)/.test(text) && !text.startsWith("**")) {
						const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))

						hits.push(`${line + 1}: ${sourceFile.text.slice(node.getStart(sourceFile), node.getEnd())}`)
					}
				}
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)

	return hits
}

describe("the node_modules reach-around guard", () => {
	test("no path-building call spells a node_modules layout by hand outside the allowlist", async () => {
		const sources = await listCandidateSources()

		// A guard that silently stops looking is worse than no guard: if the prefilter ever finds nothing, the walk
		// is broken, not the tree clean.
		expect(sources.length).toBeGreaterThan(0)

		const offenders: Record<string, string[]> = {}

		await Promise.all(
			sources.map(async (path) => {
				const key = relative(REPO_ROOT, path)

				if (key in ALLOWED) return

				const hits = findReachArounds(await readLocalTextFile(path), path)

				if (hits.length) {
					offenders[key] = hits
				}
			})
		)

		expect(offenders).toEqual({})
	})

	test("every allowlist entry still exists and still needs the exemption", async () => {
		for (const [key, reason] of Object.entries(ALLOWED)) {
			const source = await readLocalTextFile(join(REPO_ROOT, key))

			expect(reason.length, `${key}: allowlist entries carry a reason`).toBeGreaterThan(20)

			// A stale exemption is a hole. When the site stops reaching around, the entry must go.
			expect(
				findReachArounds(source, key).length,
				`${key} no longer reaches around — drop its allowlist entry`
			).toBeGreaterThan(0)
		}
	})
})
