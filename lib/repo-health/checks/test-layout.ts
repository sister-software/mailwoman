/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Enforce that each test sits beside the module it covers.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { dirname, relative, resolvePath, sep } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

const vitestTestPattern = /\.test\.tsx?$/u
const playwrightSpecPattern = /\.spec\.tsx?$/u
const moduleSourcePattern = /\.(?:ts|tsx|mts|js|mjs)$/u

/**
 * Playwright suites under `test/` in a workspace that has a `playwright.config.ts`.
 *
 * `browser` holds page specs, `build` holds a build-health project and `e2e` holds shared fixtures.
 */
const playwrightSuites = new Set(["browser", "build", "e2e"])

/**
 * The `test-layout` check.
 *
 * A Vitest file (`<name>.test.ts`) sits beside the module it covers.
 * The `.integration.test.ts` and `.full.test.ts` suffixes select the slow and full suites.
 *
 * A Playwright spec (`<name>.spec.ts`) sits under `test/{browser,build,e2e}/`.
 * Only a workspace with a `playwright.config.ts` holds one.
 */
export const testLayoutCheck: RepoCheck = {
	id: "test-layout",
	description: "Each test sits beside the module it covers; Playwright specs sit under test/{browser,build,e2e}/.",
	async run(context) {
		const root = context.repoRoot
		const diagnostics: Diagnostic[] = []
		const sources = await trackedSourcePaths(context, { existingOnly: true })
		const moduleDirectories = new Set<string>()

		for (const filePath of sources) {
			if (!moduleSourcePattern.test(filePath) || vitestTestPattern.test(filePath)) continue

			if (playwrightSpecPattern.test(filePath) || filePath.endsWith(".d.ts")) continue

			moduleDirectories.add(dirname(filePath))
		}

		for (const workspace of await readWorkspaceDirectories(root)) {
			const workspaceRoot = resolvePath(root, workspace)
			const runsPlaywright = await pathExists(resolvePath(workspaceRoot, "playwright.config.ts"))

			for (const filePath of sources) {
				if (!filePath.startsWith(`${workspaceRoot}/`)) continue

				const file = relative(root, filePath)

				if (vitestTestPattern.test(filePath)) {
					if (!moduleDirectories.has(dirname(filePath))) {
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							message: "a test belongs beside the module it covers; this directory holds no module",
							file,
							line: null,
							details: null,
						})
					}

					continue
				}

				if (playwrightSpecPattern.test(filePath)) {
					const [top, suite] = relative(workspaceRoot, filePath).split(sep)

					if (!runsPlaywright || top !== "test" || !playwrightSuites.has(suite ?? "")) {
						diagnostics.push({
							severity: DiagnosticSeverity.Error,
							message: runsPlaywright
								? "a Playwright spec belongs under test/{browser,build,e2e}/"
								: "a .spec.ts file needs a playwright.config.ts in its workspace; a Vitest file is named .test.ts",
							file,
							line: null,
							details: null,
						})
					}
				}
			}
		}

		return diagnostics
	},
}
