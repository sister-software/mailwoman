/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This check finds callers that hand-assemble paths into another package's install directory.
 *   For example, `resolve(root, "node_modules/@mailwoman/neural-weights-en-us/model.onnx")` embeds an install path.
 *   Callers can ask Node where a package lives or expose the file through an `exports` subpath.
 *
 *   The assembled path relies on an install layout the package owner has not promised.
 *   A package move, scope rename, hoist, or `files` change can make it point nowhere.
 *   The caller may then report a missing artifact even though it looked in the wrong place.
 *
 *   The TypeScript AST finds install paths in path-building calls, filesystem and process calls,
 *   literal variable initializers, and interpolated templates, including templates stored in arrays.
 *   A substring prefilter avoids parsing files that mention `node_modules` in Vitest exclude globs,
 *   `.gitignore`-shaped arrays, or prose.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { join, relative } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"
import { readContextSource, readContextSources } from "#repo-health/context"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The shortest allowlist reason a reviewer can read as a reason rather than a label.
 */
const MINIMUM_REASON_LENGTH = 20

/**
 * The path-building functions this guard watches — `node:path`'s two composers
 * and path-ts's, in bare or `path.` qualified form, plus the `TemporaryDirectory`
 * builder called as `scratch.path("node_modules", …)`.
 *
 * The check is on the name by itself, so a rename-import (`join as pathJoin`) slips past,
 * the accepted hole that closing would require resolving imports.
 */
const PATH_BUILDERS = new Set(["join", "path", "resolve", "resolvePath", "resolvePathBuilder"])

/**
 * Process and filesystem calls consume paths directly without a path-building call.
 */
const DIRECT_PATH_USERS = new Set([
	"runFile",
	"runFileSync",
	"spawnProcess",
	"spawnProcessSync",
	"execFile",
	"execFileSync",
	"spawn",
	"spawnSync",
	"fork",
	"readLocalTextFile",
	"readLocalJSONFile",
	"readLocalBuffer",
	"readFileHead",
	"readFileRange",
	"pathExists",
	"statPath",
	"open",
	"writeLocalTextFile",
	"writeLocalJSONFile",
	"createSymbolicLink",
	"copyPath",
	"readFile",
	"writeFile",
	"stat",
	"lstat",
	"access",
])

/**
 * Every site allowed to spell a `node_modules` path by hand, keyed by repo-relative
 * path with the reason for it.
 */
const ALLOWED: Record<string, string> = {
	// The oracle for that layout: a fixture built with the implementation's own helper cannot fail
	// when the implementation is wrong, so this file spells the path independently.
	"packages/neural/lib/weights/cache.integration.test.ts":
		"pins the cache layout independently of the helper that builds it",
	// Probes a foreign scratch project it just created with `npm install`, reading the install
	// layout from outside because `import.meta.resolve` would answer from the monorepo's graph.
	"lib/release-kit/release/smoke/clean-install.ts":
		"inspects a scratch project's install layout from outside, by design",
	"lib/release-kit/release/smoke/installed-bin.ts":
		"reads the bin entry from a scratch project's installed manifest, for both clean-install smokes",
	// Builds the node_modules symlink farm a git worktree lacks rather than reading one,
	// so there is no path to resolve until this code creates the directory.
	"lib/dev-mcp/worktree/arm.ts": "constructs the worktree's node_modules farm; nothing exists to resolve yet",
	// The oracle for that farm: a fixture built with the implementation's own helper
	// cannot fail when the implementation is wrong.
	"lib/dev-mcp/worktree/worktree-arm.test.ts": "pins the farm layout independently of the code that builds it",
	// Builds a scratch workspace's node_modules link so a bare `@fixture/recipes` specifier resolves.
	// A fixture without an install layout cannot test Yarn's resolution behavior.
	"lib/repo-health/move/plan.test.ts": "builds the scratch workspace's install link; nothing exists to resolve yet",
	// Writes a fixture cache in the npm-prefix layout `weightsCachePackageDir` reads,
	// spelled out so the cache rung's test stays independent of the helper it exercises.
	"packages/neural/lib/weights/overlay.integration.test.ts":
		"builds a fixture cache in the npm-prefix layout, independently",
	// Plants a fake `@vvago/vale` install under a scratch root so `valeCommand`'s resolution
	// of the launcher and binary from an installed layout can be tested.
	"packages/core/lib/vale.test.ts": "builds a fake @vvago/vale install for the resolver under test",
	"packages/core/lib/module/package-command.test.ts":
		"builds nested fixture installs independently of package executable resolution",
	"lib/repo-health/checks/node-modules-reacharound.test.ts":
		"records source snippets containing install paths as inputs to the checker",
	"lib/dev-mcp/routed-mailwoman-arm.test.ts":
		"records candidate package paths in mocked weights results rather than resolving installed dependencies",
	// Links the checkout's own node_modules into the staging tree for `yarn pack`'s
	// project context, addressing no package-owned path by hand.
	"lib/release-kit/release/stage.ts":
		"symlinks the checkout's node_modules into the staging tree; not a package lookup",
	// `weightsCachePackageDir` is the inverse of a resolution rather than a substitute for one:
	// the directory does not exist yet when the layout is needed, so there is no path to resolve.
	"packages/neural/lib/weights.ts": "weightsCachePackageDir — the single home for the npm-prefix cache layout",
}

/**
 * Every tracked source that mentions `node_modules` at all.
 *
 * Git tracks the source files this check scans.
 * CI cannot reproduce scratchpad probes, agent worktrees, or local build output,
 * so those remain outside the check.
 */
async function listCandidateSources(context: RepoContext): Promise<string[]> {
	const tracked = await trackedSourcePaths(context, { existingOnly: true })
	const texts = await readContextSources(context, tracked)

	return tracked.filter((_path, index) => texts[index]!.includes("node_modules")).toSorted()
}

/**
 * Reports install paths used to build paths, read files, or launch processes, with each source line.
 *
 * Both a plain string and a template literal count, since the interpolated form is
 * what a "make it dynamic" refactor reaches for first.
 */
export function findReachArounds(source: string, fileName: string): Array<{ line: number; text: string }> {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
	const hits: Array<{ line: number; text: string }> = []
	const reported: Array<{ start: number; end: number }> = []

	const argumentText = (node: ts.Node): string | null => {
		// `isStringLiteralLike` already covers a no-substitution template.
		if (ts.isStringLiteralLike(node)) return node.text

		// An interpolated template is spliced with a NUL for each `${…}` expression.
		// The segment test then sees the chunks.
		// The raw source begins with a backtick.
		// That character cannot match the leading-segment anchor.
		if (ts.isTemplateExpression(node)) {
			return node.head.text + node.templateSpans.map((span) => `\0${span.literal.text}`).join("")
		}

		return null
	}

	const isInstallPath = (text: string | null): boolean =>
		text !== null && /(^|[/\\])node_modules([/\\]|$)/u.test(text) && !/^!?\*\*/u.test(text)

	const report = (node: ts.Node): void => {
		const start = node.getStart(sourceFile)

		if (reported.some((range) => start >= range.start && node.getEnd() <= range.end)) return
		reported.push({ start, end: node.getEnd() })
		const { line } = sourceFile.getLineAndCharacterOfPosition(start)

		hits.push({ line: line + 1, text: sourceFile.text.slice(start, node.getEnd()) })
	}

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = ts.isPropertyAccessExpression(node.expression)
				? node.expression.name.text
				: ts.isIdentifier(node.expression)
					? node.expression.text
					: undefined

			// A `PathBuilder` is invoked as a bare function, so a descent through `node_modules`
			// has no callee name to match and the leading segment is the tell.
			// Property calls are left out because `.includes("node_modules")` is a
			// string test rather than a path.
			const firstArgument = node.arguments[0]

			const descendsIntoNodeModules =
				ts.isIdentifier(node.expression) &&
				firstArgument !== undefined &&
				argumentText(firstArgument) === "node_modules"

			const buildsPath = (callee !== undefined && PATH_BUILDERS.has(callee)) || descendsIntoNodeModules
			const consumesPath = callee !== undefined && DIRECT_PATH_USERS.has(callee)

			if (buildsPath) {
				for (const argument of node.arguments) {
					const text = argumentText(argument)

					// A `node_modules` path segment rather than the bare word, so an exclude
					// glob like `**/node_modules/**` inside a `join` does not fire.
					if (isInstallPath(text)) {
						report(node)
					}
				}
			}

			if (consumesPath && firstArgument && isInstallPath(argumentText(firstArgument))) {
				report(node)
			}
		}

		if (
			ts.isVariableDeclaration(node) &&
			node.initializer &&
			ts.isStringLiteralLike(node.initializer) &&
			isInstallPath(node.initializer.text)
		) {
			report(node.initializer)
		}

		if (ts.isTemplateExpression(node) && isInstallPath(argumentText(node))) {
			report(node)
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)

	return hits
}

/**
 * The `node-modules-reacharound` check: one error per hand-spelled `node_modules`
 * path outside the allowlist.
 *
 * It also reports each allowlist entry that no longer exists or no longer reaches around.
 */
export const nodeModulesReacharoundCheck: RepoCheck = {
	id: "node-modules-reacharound",
	description: "No filesystem or executable lookup spells a node_modules layout outside the reasoned allowlist.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const sources = await listCandidateSources(context)

		// A guard that silently stops looking is worse than no guard: no source found
		// means the walk is broken rather than the tree clean.
		if (!sources.length) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: "no tracked source mentions node_modules at all — the prefilter is broken, not the tree clean",
				file: null,
				line: null,
				details: null,
			})
		}

		await Promise.all(
			sources.map(async (path) => {
				const key = relative(context.repoRoot, path)

				if (key in ALLOWED) return

				for (const hit of findReachArounds(await readContextSource(context, path), path)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `hand-assembled node_modules path: ${hit.text}`,
						file: key,
						line: hit.line,
						details: null,
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
					line: null,
					details: null,
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
					line: null,
					details: null,
				})

				continue
			}

			// A stale exemption is a hole, so an entry whose site stops reaching around must go.
			if (!findReachArounds(source, key).length) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: "no longer reaches around — drop its allowlist entry",
					file: key,
					line: null,
					details: null,
				})
			}
		}

		return diagnostics.toSorted((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0))
	},
}
