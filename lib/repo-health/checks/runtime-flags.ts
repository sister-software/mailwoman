/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every flag in the runtime-flag register must be touched by at least one test.
 *
 *   Operator ruling: **a flag with no test is either up for removal or needs a test.**
 *   Both cases require action. This check prevents the question from going unanswered because a manual sweep becomes stale.
 *
 *   A test counts when its name appears anywhere in the file, including in prose.
 *   This check finds flags with no connection to the test suite. Other checks assess coverage quality.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

const REGISTER = "docs/engineering/reference/runtime-flags.mdx"

/**
 * A register that parses fewer flags than this means the parser matched no flag
 * and every assertion below would be vacuously true.
 */
const PLAUSIBLE_REGISTER_SIZE = 20

/**
 * Register rows name their flag in leading backticks.
 *
 * A struck row (`~~`flag`~~`) is skipped as a record of something that no longer exists.
 */
function registerFlags(markdown: string): string[] {
	const flags = new Set<string>()

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one register file, read whole and bounded
	for (const line of markdown.split("\n")) {
		if (!line.startsWith("| `")) continue

		const match = /^\| `([A-Za-z][A-Za-z0-9_]*)`/.exec(line)

		if (match?.[1]) {
			flags.add(match[1])
		}
	}

	return [...flags].toSorted()
}

/**
 * Flags with no test, each with the reason it is allowed to have none.
 *
 * Each entry identifies an outstanding task.
 * Keep the list short and identify the owner and task on every line.
 */
const UNCOVERED_ALLOWLIST: Record<string, string> = {}

/**
 * The `runtime-flags` check: one error per registered flag no test under `packages/`
 * or `lib/` touches, plus one per stale allowlist entry.
 */
export const runtimeFlagsCheck: RepoCheck = {
	id: "runtime-flags",
	description: "Every flag in the runtime-flag register is touched by at least one test under packages/ or lib/.",
	async run(context) {
		const flags = registerFlags(await readLocalTextFile(resolvePath(context.repoRoot, REGISTER)))
		const diagnostics: Diagnostic[] = []

		if (flags.length <= PLAUSIBLE_REGISTER_SIZE) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `parsed ${flags.length} flags out of the register; more than ${PLAUSIBLE_REGISTER_SIZE} are expected, so the parser matched nothing`,
				file: REGISTER,
			})
		}

		const testFiles = await trackedSourcePaths(context, {
			globs: ["packages/*.test.ts", "packages/*.test.tsx", "lib/*.test.ts", "lib/*.test.tsx"],
			existingOnly: true,
		})

		const corpus = await Promise.all(testFiles.map((path) => readLocalTextFile(path)))
		const covered = (flag: string): boolean => corpus.some((source) => new RegExp(`\\b${flag}\\b`).test(source))

		for (const flag of flags) {
			if (covered(flag) || flag in UNCOVERED_ALLOWLIST) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `registered flag ${flag} has NO test touching it — either a flag to delete or coverage to write; if neither yet, add it to UNCOVERED_ALLOWLIST with the reason and the tracking issue`,
				file: REGISTER,
			})
		}

		for (const flag of Object.keys(UNCOVERED_ALLOWLIST)) {
			const isCovered = covered(flag)
			const registered = flags.includes(flag)

			if (isCovered || !registered) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${flag} is allowlisted as uncovered but is now ${isCovered ? "covered by a test" : "absent from the register"} — drop the allowlist entry`,
					file: REGISTER,
				})
			}
		}

		return diagnostics
	},
}
