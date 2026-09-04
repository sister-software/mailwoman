/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Type-check every workspace's test files.
 *
 *   `tsc -b` deliberately skips them: the build project excludes tests because anything it includes is emitted into
 *   `out/` and then published. That `exclude` suppressed the emit AND the checking, so for most of this repo's life
 *   test files were compiled by vitest's esbuild transform, which strips types without looking at them.
 *
 *   Each workspace carries a `tsconfig.test.json` — non-emitting, referencing its own build project so siblings resolve
 *   through their built `.d.ts`. This runs them all and reports one diagnostic per `tsc` error line.
 */

import { runFile } from "@mailwoman/core/process"
import { cpuCount } from "@mailwoman/core/utils/system"
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"

/**
 * How many `tsc` invocations to keep in flight. Each is single-threaded and mostly CPU-bound.
 */
const CONCURRENCY = Math.max(2, Math.min(8, cpuCount() - 2))

/**
 * A tracked `tsconfig.test.json` one directory below the root or below `packages/`, which is where every workspace and
 * the `scripts/` project sit.
 */
const TEST_PROJECT = /^(?:packages\/)?[^/]+\/tsconfig\.test\.json$/

/**
 * Run `tsc` against one workspace's test project. A non-zero exit carries the diagnostics on stdout, so a rejected
 * promise is the normal path for a workspace with errors.
 */
async function typecheck(workspace: string, repoRoot: string): Promise<Diagnostic[]> {
	const config = join(workspace, "tsconfig.test.json")

	try {
		await runFile("./node_modules/.bin/tsc", ["-p", config, "--noEmit", "--pretty", "false"], { cwd: repoRoot })

		return []
	} catch (error) {
		const output = String((error as { stdout?: string }).stdout ?? "")

		return [...TextSpliterator.from(output)]
			.filter((line) => line.includes("error TS"))
			.map((line) => ({ severity: DiagnosticSeverity.Error, message: line, file: workspace }))
	}
}

/**
 * The workspaces whose tests get type-checked: every tracked test project, sorted.
 */
export function testProjectWorkspaces(context: RepoContext): string[] {
	return context.trackedFiles
		.filter((path) => TEST_PROJECT.test(path))
		.map((path) => path.slice(0, -"/tsconfig.test.json".length))
		.toSorted()
}

/**
 * The `typecheck-tests` check: one error per `tsc` error line across every workspace's test project.
 */
export const typecheckTestsCheck: RepoCheck = {
	id: "typecheck-tests",
	description: "Every workspace's test project (tsconfig.test.json) type-checks under tsc --noEmit.",
	async run(context) {
		const queue = testProjectWorkspaces(context)
		const diagnostics: Diagnostic[] = []

		await Promise.all(
			Array.from({ length: CONCURRENCY }, async () => {
				for (let next = queue.shift(); next; next = queue.shift()) {
					diagnostics.push(...(await typecheck(next, context.repoRoot)))
				}
			})
		)

		return diagnostics.toSorted((a, b) => (a.file ?? "").localeCompare(b.file ?? ""))
	},
}
