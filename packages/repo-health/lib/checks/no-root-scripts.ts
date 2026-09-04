/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file There is no root `scripts/` directory, and CI runs no bare `lib/*.ts` path.
 *
 *   An executable enters the repository through a registry (`@mailwoman/release-kit`, `@mailwoman/repo-health`), a
 *   `mailwoman` command, or a `packages/mailwoman/lib/dev-tools/*.run.ts` measurement. A free-standing file under a
 *   root `scripts/` directory is none of those: knip could not see whether anything ran it, and 44 of 71 such files
 *   were unreferenced when the directory was emptied. This check refuses the three ways the directory grows back: a
 *   tracked file under `scripts/`, code that builds a path into it, and a workflow or `package.json` target that
 *   runs `scripts/...` or a bare `lib/*.ts` path instead of a registered entry point.
 *
 *   Workspace-local `scripts/` directories (`packages/<name>/scripts/`, `docs/scripts/`, `corpus-python/scripts/`)
 *   are not the root drawer and stay out of scope; a string that names one of them is matched by its prefix.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * A code line that builds a path into the root drawer: a `repoRootPath("scripts", …)` call or a string literal that
 * starts with `scripts/`. Comment lines are skipped, because history is allowed to name the directory that was.
 */
const ROOT_SCRIPTS_PATH = /repoRootPath(?:Builder)?\(\s*["']scripts["']|["'`]scripts\//u

/**
 * A `run:` step or a `package.json` target that executes a root script or a bare library path.
 */
const ROOT_SCRIPTS_RUN = /(?:^|[\s"'`(])(?:node|tsx|yarn node)\s+(?:\.\/)?scripts\//u
const BARE_LIB_RUN = /(?:^|[\s"'`(])(?:node|tsx|yarn node)\s+\S*\/lib\/\S*\.tsx?(?:\s|$|["'`)])/u

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/u

/**
 * The one library path a target may run: the `mwops` adapter is the registry's command-line view, and the private CLI
 * has no compiled bin, so `package.json`'s `mwops` target names its source. Every other executable reaches CI through
 * it.
 */
const REGISTERED_ADAPTERS = new Set(["packages/ops-cli/lib/cli.ts"])

function runsRegisteredAdapter(line: string): boolean {
	return [...REGISTERED_ADAPTERS].some((adapter) => line.includes(adapter))
}

function isTestFile(path: string): boolean {
	return /\.(?:test|spec)\.tsx?$/u.test(path) || path.includes("/test/")
}

/**
 * The check the `scripts/` migration ends on: the directory is gone and every executable reaches CI through a registry.
 */
export const noRootScriptsCheck: RepoCheck = {
	id: "no-root-scripts",
	description:
		"No tracked file under a root scripts/ directory, no code path built into one, and no CI or package.json target that runs scripts/… or a bare lib/*.ts path.",
	async run(context) {
		const root = context.repoRoot
		const diagnostics: Diagnostic[] = []

		for (const tracked of context.trackedFiles) {
			if (tracked.startsWith("scripts/")) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file: tracked,
					message:
						"A file under the root scripts/ directory. Register it as an operation, a check, a command, or a dev-tools measurement.",
				})
			}
		}

		const codeFiles = await trackedSourcePaths(context, {
			globs: [
				"packages/*/lib/**/*.ts",
				"packages/*/lib/**/*.tsx",
				"docs/src/**/*.ts",
				"docs/src/**/*.tsx",
				"docs/plugins/**/*.ts",
			],
			existingOnly: true,
		})

		for (const filePath of codeFiles) {
			const file = relative(root, filePath)

			if (isTestFile(file)) continue
			let index = 0

			for (const line of TextSpliterator.from(await readLocalTextFile(filePath), { skipEmpty: false })) {
				index++

				if (COMMENT_LINE.test(line) || !ROOT_SCRIPTS_PATH.test(line)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					line: index,
					message: "Builds a path into the root scripts/ directory, which does not exist.",
				})
			}
		}

		const runners = await trackedSourcePaths(context, {
			globs: [".github/workflows/*.yml", ".github/workflows/*.yaml", ".husky/*", "package.json", ".release-it.json"],
			existingOnly: true,
		})

		for (const filePath of runners) {
			const file = relative(root, filePath)
			let index = 0

			for (const line of TextSpliterator.from(await readLocalTextFile(filePath), { skipEmpty: false })) {
				index++

				if (/^\s*#/u.test(line)) continue

				if (ROOT_SCRIPTS_RUN.test(line)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						file,
						line: index,
						message:
							"Runs a root scripts/ path. Call the registered entry point (`yarn mwops …` or a `mailwoman` command).",
					})
				} else if (BARE_LIB_RUN.test(line) && !runsRegisteredAdapter(line)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						file,
						line: index,
						message:
							"Runs a bare lib/*.ts path. CI executes registered entry points only (`yarn mwops …` or a `mailwoman` command).",
					})
				}
			}
		}

		return diagnostics
	},
}
