/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every flag in the runtime-flag register must be touched by at least one test.
 *
 *   Operator ruling: **a flag no test touches is either up for removal, or an indication of missing testing.** Both
 *   readings are actionable and neither is "leave it"; what is not acceptable is not knowing which one applies. This
 *   check makes the question impossible to skip, because the sweep that answers it by hand rots the day after it runs.
 *
 *   The sweep that motivated it found two register entries with zero test files, and they had decayed in opposite
 *   directions — which is exactly why the two readings both have to stay open: one flag restricted a union with a parser
 *   deleted two majors earlier (removal), and one reached ~1,850 lines of well-tested implementation through a switch
 *   nothing tested (missing testing — of the switch, not the switched).
 *
 *   MATCHING IS DELIBERATELY LOOSE. A flag name appearing anywhere in a test file counts, including in prose. A stricter
 *   check (the flag passed as an option, say) would be more meaningful and far more fragile, and this check's job is to
 *   catch a flag with NO connection to the suite at all, not to grade the quality of the coverage it finds.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

const REGISTER = "docs/engineering/reference/runtime-flags.mdx"

/**
 * A register that parses fewer flags than this is a parser that silently matched nothing, and every assertion below
 * would be vacuously true.
 */
const PLAUSIBLE_REGISTER_SIZE = 20

/**
 * Register rows name their flag in leading backticks. A STRUCK row (`~~`flag`~~`) is a record of something that no
 * longer exists and is skipped — striking is how a removed flag keeps its measurement without claiming to be live.
 */
export function registerFlags(markdown: string): string[] {
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
 * Flags with no test, each with the reason it is allowed to have none. An entry here is a DEBT with a name, not an
 * exemption — the point of the list is that it is short enough to read and every line carries who owes what.
 */
const UNCOVERED_ALLOWLIST: Record<string, string> = {}

/**
 * The `runtime-flags` check: one error per registered flag no test under `packages/` touches, plus one per stale
 * allowlist entry.
 */
export const runtimeFlagsCheck: RepoCheck = {
	id: "runtime-flags",
	description: "Every flag in the runtime-flag register is touched by at least one test under packages/.",
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
			globs: ["packages/*.test.ts", "packages/*.test.tsx"],
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
