/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

const ROOT_SCRIPTS_PATH = /repoRootPath(?:Builder)?\(\s*["']scripts["']|["'`]scripts\//u

const ROOT_SCRIPTS_RUN = /(?:^|[\s"'`(])(?:node|tsx|yarn node)\s+(?:\.\/)?scripts\//u
const BARE_LIB_RUN = /(?:^|[\s"'`(])(?:node|tsx|yarn node)\s+\S*\/lib\/\S*\.tsx?(?:\s|$|["'`)])/u

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/u

const SELF = "packages/repo-health/lib/checks/no-root-scripts.ts"

const REGISTERED_ADAPTERS = new Set(["packages/ops-cli/lib/cli.ts"])

function runsRegisteredAdapter(line: string): boolean {
	return [...REGISTERED_ADAPTERS].some((adapter) => line.includes(adapter))
}

function isTestFile(path: string): boolean {
	return /\.(?:test|spec)\.tsx?$/u.test(path) || path.includes("/test/")
}

/**
 * Checks that no root `scripts/` directory exists or is referenced, and that CI
 * and package targets run only registered entry points rather than bare `lib/*.ts` paths.
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
				"packages/*/lib/*.ts",
				"packages/*/lib/*.tsx",
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

			if (file === SELF || isTestFile(file)) continue
			let index = 0

			for (const line of TextSpliterator.from(await readLocalTextFile(filePath), { skipEmpty: false })) {
				index++

				if (COMMENT_LINE.test(line) || !ROOT_SCRIPTS_PATH.test(line)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					line: index,
					message: "Builds a path into the absent root scripts/ directory.",
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
