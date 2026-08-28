/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every flag in the runtime-flag register must be touched by at least one test.
 *
 *   Operator ruling 2026-08-19: **a flag no test touches is either up for removal, or an indication of
 *   missing testing.** Both readings are actionable and neither is "leave it"; what is not acceptable is
 *   not knowing which one applies. This guard makes the question impossible to skip, because the sweep
 *   that answers it by hand rots the day after it runs.
 *
 *   The sweep that motivated it found two register entries with zero test files, and they had decayed in
 *   opposite directions — which is exactly why the two readings both have to stay open:
 *
 *   - `arbitrate` did not exist in any source file. It gated a union with the LEGACY RULE PARSER, deleted
 *       in v7.0.0, so it had gated nothing for two majors. Removal.
 *   - `jointReconcile` is live in `runtime-pipeline.ts` and reaches ~1,850 lines of well-tested reconcile
 *       implementation. The MECHANISM has a 648-line kryptonite suite; the FLAG that reaches it has nothing.
 *       Missing testing — of the switch, not the switched.
 *
 *   MATCHING IS DELIBERATELY LOOSE. A flag name appearing anywhere in a test file counts, including in
 *   prose. A stricter check (the flag passed as an option, say) would be more meaningful and far more
 *   fragile, and this guard's job is to catch a flag with NO connection to the suite at all — the
 *   `arbitrate` shape — not to grade the quality of the coverage it finds.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

const REGISTER = String(repoRootPath("docs", "engineering", "reference", "runtime-flags.mdx"))

/**
 * Register rows name their flag in leading backticks. A STRUCK row (`~~`flag`~~`) is a record of something that no
 * longer exists and is skipped — striking is how a removed flag keeps its measurement without claiming to be live.
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
 * Flags with no test, each with the reason it is allowed to have none. An entry here is a DEBT with a name, not an
 * exemption — the point of the list is that it is short enough to read and every line carries who owes what.
 */
const UNCOVERED_ALLOWLIST: Record<string, string> = {}

function testFilesUnder(directory: string, found: string[] = []): string[] {
	if (!existsSync(directory)) return found

	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules" || entry === "out" || entry.startsWith(".")) continue

		const full = join(directory, entry)

		if (statSync(full).isDirectory()) {
			testFilesUnder(full, found)
		} else if (/\.test\.tsx?$/.test(entry)) {
			found.push(full)
		}
	}

	return found
}

describe("runtime-flag register", () => {
	const markdown = readFileSync(REGISTER, "utf8")
	const flags = registerFlags(markdown)

	it("parses a plausible number of flags out of the register", () => {
		// A parser that silently matched nothing would make every assertion below vacuously true.
		expect(flags.length).toBeGreaterThan(20)
	})

	it("every registered flag is touched by at least one test — removal or missing coverage, never neither", () => {
		const corpus = testFilesUnder(String(repoRootPath("packages"))).map((path) => readFileSync(path, "utf8"))

		const uncovered = flags.filter((flag) => {
			const pattern = new RegExp(`\\b${flag}\\b`)

			return !corpus.some((source) => pattern.test(source))
		})

		const unexplained = uncovered.filter((flag) => !(flag in UNCOVERED_ALLOWLIST))

		expect(
			unexplained,
			`Registered flag(s) with NO test touching them: ${unexplained.join(", ")}. Per the 2026-08-19 ruling ` +
				"that is either a flag to delete or coverage to write — decide which, and if it is neither yet, add it " +
				"to UNCOVERED_ALLOWLIST with the reason and the tracking issue."
		).toEqual([])
	})

	it("the allowlist carries no flag that has since gained coverage, or left the register", () => {
		const corpus = testFilesUnder(String(repoRootPath("packages"))).map((path) => readFileSync(path, "utf8"))

		for (const flag of Object.keys(UNCOVERED_ALLOWLIST)) {
			const covered = corpus.some((source) => new RegExp(`\\b${flag}\\b`).test(source))
			const registered = flags.includes(flag)

			expect(
				covered || !registered,
				`${flag} is allowlisted as uncovered but is now ${covered ? "covered by a test" : "absent from the register"} — drop the allowlist entry.`
			).toBe(false)
		}
	})
})
