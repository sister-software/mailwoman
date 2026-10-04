/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Type-check every workspace's test files.
 *
 *   `tsc -b` deliberately skips them: the build project excludes tests because anything it includes is emitted into
 *   `out/` and then published. That `exclude` suppressed the emit and the checking, so for most of this repo's life
 *   test files were compiled by vitest's esbuild transform. It strips types without checking them.
 *
 *   Each workspace has a `tsconfig.test.json` — non-emitting, referencing its own build project so siblings resolve
 *   through their built `.d.ts`. This runs them all and reports one diagnostic per `tsc` error line.
 */

import { errorMessage } from "@mailwoman/core/errors/schema"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { resolvePackageCommand, type PackageCommand } from "@mailwoman/core/module/package-command"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { cpuCount } from "@mailwoman/core/utils/system"
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#repo-health/check"

/**
 * How many `tsc` invocations to keep in flight.
 *
 * Each is single-threaded and mostly CPU-bound.
 */
const CONCURRENCY = Math.max(2, Math.min(8, cpuCount() - 2))

/**
 * The pattern selects a tracked `tsconfig.test.json` immediately under a workspace root.
 */
const TEST_PROJECT = /^(?:packages\/)?[^/]+\/tsconfig\.test\.json$/

/**
 * Runs `tsc` against one workspace's test project.
 *
 * TypeScript errors may appear on stdout or stderr with a numeric nonzero exit.
 * Launch failures, interruptions, and exits without TypeScript diagnostics
 * produce a separate error diagnostic.
 */
async function* typecheck(
	workspace: string,
	repoRoot: string,
	command: PackageCommand
): AsyncGenerator<Diagnostic, void, unknown> {
	const config = join(workspace, "tsconfig.test.json")

	try {
		await runFile(command.file, [...command.argv, "-p", config, "--noEmit", "--pretty", "false"], { cwd: repoRoot })
	} catch (error) {
		const output = isProcessError(error) ? `${error.stdout}\n${error.stderr}` : ""

		const lines = TextSpliterator.from(output)
			.filter((line) => line.includes("error TS"))
			.toArray()

		for (const line of lines) {
			yield { severity: DiagnosticSeverity.Error, message: line, file: workspace }
		}

		if (!lines.length || !isProcessError(error) || typeof error.code !== "number" || error.signal) {
			yield {
				severity: DiagnosticSeverity.Error,
				message: `TypeScript did not complete for ${config}: ${errorMessage(error)}`,
				file: config,
				...(output.trim() ? { details: [output.trim()] } : {}),
			}
		}
	}
}

/**
 * Returns the workspaces with tracked test projects, sorted by path.
 */
function testProjectWorkspaces(context: RepoContext): string[] {
	return context.trackedFiles
		.filter((path) => TEST_PROJECT.test(path))
		.map((path) => path.slice(0, -"/tsconfig.test.json".length))
		.toSorted()
}

/**
 * The check reports TypeScript errors and failures to resolve, launch, or finish the compiler.
 */
export const typecheckTestsCheck: RepoCheck = {
	id: "typecheck-tests",
	description: "Every workspace's test project (tsconfig.test.json) type-checks under tsc --noEmit.",
	async run(context) {
		const queue = testProjectWorkspaces(context)
		const diagnostics: Diagnostic[] = []
		let command: PackageCommand

		if (!queue.length) return diagnostics

		try {
			const base = pathToFileURL(join(context.repoRoot, "package.json")).href

			command = await resolvePackageCommand(base, "@typescript/native", "tsc")
		} catch (error) {
			return [
				{
					severity: DiagnosticSeverity.Error,
					message: `Could not resolve the TypeScript compiler for ${context.repoRoot}: ${errorMessage(error)}`,
					file: "package.json",
				},
			]
		}

		await Promise.all(
			Array.from({ length: CONCURRENCY }, async () => {
				for (let next = queue.shift(); next; next = queue.shift()) {
					for await (const diag of typecheck(next, context.repoRoot, command)) {
						diagnostics.push(diag)
					}
				}
			})
		)

		return diagnostics.toSorted((a, b) => (a.file ?? "").localeCompare(b.file ?? ""))
	},
}
