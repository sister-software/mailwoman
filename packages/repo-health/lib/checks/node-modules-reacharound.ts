/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Guard for the node_modules reach-around.
 *
 *   The defect this catches: hand-assembling a path into another package's install directory —
 *   `resolve(root, "node_modules/@mailwoman/neural-weights-en-us/model.onnx")` — instead of asking Node where that
 *   package lives (`import.meta.resolve`, `createRequire().resolve`) or exposing the file through an `exports` subpath.
 *   The assembled literal encodes a layout its owner never agreed to: it survives a package moving, a scope rename, a
 *   hoist, and a `files` change by silently pointing at nothing, and the caller reads that as "the artifact is missing"
 *   rather than "I looked in the wrong place".
 *
 *   The check targets literal `node_modules` path segments rather than general path construction.
 *
 *   Scoped to `join`/`resolve` arguments via the TypeScript AST rather than a grep, because `node_modules` appears
 *   legitimately (and constantly) in vitest exclude globs, `.gitignore`-shaped arrays, and prose. Files are prefiltered
 *   on the substring first, so the AST cost is paid on ~30 files rather than ~2,700.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { join, relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The shortest allowlist reason a reviewer can read as a reason rather than a label.
 */
const MINIMUM_REASON_LENGTH = 20

/**
 * The path-building functions this guard watches: `node:path`'s two composers and path-ts's, in bare or
 * `path.`- qualified form (the callee name is what's matched, so `path.posix.join(…)` lands on `join`).
 *
 * `path` is the `TemporaryDirectory` builder, called as `scratch.path("node_modules", …)`.
 *
 * The check is on the name alone, so a rename-import (`join as pathJoin`) slips past.
 * That is the accepted hole: it has no instances today, and closing it would mean resolving imports.
 * The surface this file deliberately does without.
 */
const PATH_BUILDERS = new Set(["join", "path", "resolve", "resolvePath", "resolvePathBuilder"])

/**
 * Every site allowed to spell a `node_modules` path by hand, with the reason it is not a reach-around.
 *
 * Keyed by repo-relative path.
 * Add an entry only with a comment that survives review.
 */
const ALLOWED: Record<string, string> = {
	// The oracle for that layout.
	// A fixture built with the implementation's own helper cannot fail when the implementation
	// is wrong, so this file spells the path out independently and ties the helper back to it.
	"packages/neural/test/integration/weights/cache.test.ts":
		"pins the cache layout independently of the helper that builds it",
	// Probes a foreign scratch project it just created with `npm install`.
	// The whole point is to read the install layout from outside; `import.meta.resolve` would answer
	// from the monorepo's graph — the exact thing the clean- install smoke exists to not consult.
	"packages/release-kit/lib/release/smoke/clean-install.ts":
		"inspects a scratch project's install layout from outside, by design",
	"packages/release-kit/lib/release/smoke/installed-bin.ts":
		"reads the bin entry from a scratch project's installed manifest, for both clean-install smokes",
	// builds a node_modules tree rather than reading one.
	// The symlink farm a worktree arm needs, because a git worktree has none and symlinking the
	// main checkout's directory across resolves every workspace back into the main checkout
	// (yarn links `@mailwoman/core -> ../../packages/core`, resolved against the symlink's real path).
	// There is nothing to resolve: the directory does not exist until this code creates it.
	"packages/dev-mcp/lib/worktree/arm.ts": "constructs the worktree's node_modules farm; nothing exists to resolve yet",
	// The oracle for that farm, on the same principle as the weights-cache pair above: a fixture
	// built with the implementation's own helper cannot fail when the implementation is wrong.
	"packages/dev-mcp/test/unit/worktree-arm.test.ts": "pins the farm layout independently of the code that builds it",
	// builds a scratch workspace's node_modules link so a bare `@fixture/recipes`
	// specifier resolves the way yarn makes it resolve.
	// The move planner under test rewrites package-subpath specifiers, and a fixture
	// with no install layout cannot exercise that family at all.
	"packages/repo-health/test/unit/move/plan.test.ts":
		"builds the scratch workspace's install link; nothing exists to resolve yet",
	// Writes a fixture cache in the npm-prefix layout `weightsCachePackageDir` reads.
	// Spelling it out here is what makes the cache rung's test independent of the helper it is exercising.
	"packages/neural/test/integration/weights/overlay.test.ts":
		"builds a fixture cache in the npm-prefix layout, independently",
	// Plants a fake `@vvago/vale` install under a scratch root.
	// `valeCommand` is tested on how it resolves the launcher and binary from an installed layout.
	// The directory does not exist until the fixture writes it.
	"packages/core/test/unit/vale.test.ts": "builds a fake @vvago/vale install for the resolver under test",
	// links the checkout's node_modules into the staging tree rather than reading a package's layout.
	// `yarn pack` needs the project context there, and the link target is the checkout
	// root's own directory rather than another package's install dir.
	// Same principle as worktree-arm: nothing package-owned is being addressed by hand.
	"packages/release-kit/lib/release/stage.ts":
		"symlinks the checkout's node_modules into the staging tree; not a package lookup",
	// the one home.
	// `weightsCachePackageDir` is the inverse of a resolution rather than a
	// substitute for one: the directory does not exist yet when the layout is needed
	// (`npm install --prefix <cacheRoot>` is about to create it, or `stage-weights-cache.ts`
	// is about to write a candidate bundle into it), so there is nothing to resolve.
	// Every other site in the tree now calls this.
	"packages/neural/lib/weights/index.ts": "weightsCachePackageDir — the single home for the npm-prefix cache layout",
}

/**
 * Every tracked source that mentions `node_modules` at all.
 * The AST cost is paid on ~30 files rather than ~2,700.
 *
 * "Ours" is the set git tracks: see `tracked-sources.ts` for why enumeration
 * reads the index rather than the disk (scratchpad probes, agent worktrees,
 * and local build output must not fail a guard CI cannot reproduce).
 */
async function listCandidateSources(context: RepoContext): Promise<string[]> {
	const tracked = await trackedSourcePaths(context, { existingOnly: true })

	const found = await Promise.all(
		tracked.map(async (path) => ((await readLocalTextFile(path)).includes("node_modules") ? path : null))
	)

	return found.filter((path): path is NonNullable<typeof path> => path !== null).toSorted()
}

/**
 * The `paths containing node_modules string arguments of every path-building call in one source file, each with its line.
 *
 * Both literal forms count: a plain string and a template literal (`` `node_modules/${scope}/${name}` ``),
 * since the interpolated form is the one a "make it dynamic" refactor reaches for first.
 */
export function findReachArounds(source: string, fileName: string): Array<{ line: number; text: string }> {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
	const hits: Array<{ line: number; text: string }> = []

	const argumentText = (node: ts.Node): string | undefined => {
		// `isStringLiteralLike` already covers a no-substitution template.
		if (ts.isStringLiteralLike(node)) return node.text

		// An interpolated template: splice the literal chunks together with a NUL standing in for each `${…}`
		// (a NUL cannot be a path separator, so it can never manufacture a segment boundary that isn't there).
		// The segment test below then sees the chunks instead of the raw source.
		// The raw source begins with a backtick, and so could never match the leading-segment anchor.
		if (ts.isTemplateExpression(node)) {
			return node.head.text + node.templateSpans.map((span) => `\0${span.literal.text}`).join("")
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

			// A `PathBuilder` is invoked as a bare function (`dir("node_modules", pkg)`),
			// so a descent through `node_modules` has no callee name to match.
			// The leading segment is the tell there.
			// Property calls are left out: `.includes("node_modules")` is a string test rather than a path.
			const firstArgument = node.arguments[0]

			const descendsIntoNodeModules =
				ts.isIdentifier(node.expression) &&
				firstArgument !== undefined &&
				argumentText(firstArgument) === "node_modules"

			const buildsPath = (callee !== undefined && PATH_BUILDERS.has(callee)) || descendsIntoNodeModules

			if (buildsPath) {
				for (const argument of node.arguments) {
					const text = argumentText(argument)

					// A `node_modules` path segment rather than the bare word.
					// This must not fire on an exclude glob like `**/node_modules/**` that
					// happens to sit inside a `join`.
					if (text && /(^|[/\\])node_modules([/\\]|$)/.test(text) && !text.startsWith("**")) {
						const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))

						hits.push({ line: line + 1, text: sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()) })
					}
				}
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)

	return hits
}

/**
 * The `node-modules-reacharound` check: one error per hand-spelled `node_modules` path outside
 * the allowlist, and one per allowlist entry that no longer exists or no longer reaches around.
 */
export const nodeModulesReacharoundCheck: RepoCheck = {
	id: "node-modules-reacharound",
	description: "No path-building call spells a node_modules layout by hand outside the reasoned allowlist.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const sources = await listCandidateSources(context)

		// A guard that silently stops looking is worse than no guard: if the prefilter
		// ever finds nothing, the walk is broken rather than the tree clean.
		if (!sources.length) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: "no tracked source mentions node_modules at all — the prefilter is broken, not the tree clean",
			})
		}

		await Promise.all(
			sources.map(async (path) => {
				const key = relative(context.repoRoot, path)

				if (key in ALLOWED) return

				for (const hit of findReachArounds(await readLocalTextFile(path), path)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `hand-assembled node_modules path: ${hit.text}`,
						file: key,
						line: hit.line,
					})
				}
			})
		)

		for (const [key, reason] of Object.entries(ALLOWED)) {
			if (reason.length <= MINIMUM_REASON_LENGTH) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: "allowlist entries carry a reason a reviewer can read",
					file: key,
				})
			}

			let source: string

			try {
				source = await readLocalTextFile(join(context.repoRoot, key))
			} catch {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: "allowlisted file no longer exists — drop its entry, or move it with the file",
					file: key,
				})

				continue
			}

			// A stale exemption is a hole.
			// When the site stops reaching around, the entry must go.
			if (!findReachArounds(source, key).length) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: "no longer reaches around — drop its allowlist entry",
					file: key,
				})
			}
		}

		return diagnostics.toSorted((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0))
	},
}
