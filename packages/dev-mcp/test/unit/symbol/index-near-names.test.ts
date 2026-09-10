/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The near-name half of the symbol index: which shorter names a new name is read as a longer spelling of, and
 *   that the precheck reports one from the tree. Exact-name matching is covered by `symbol-precheck.test.ts`; this
 *   file exists because the near-name rule shipped once with no test at all.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { containedNameCandidates, formatFindings } from "@mailwoman/dev-mcp/symbol-index"
import { describe, expect, it } from "vitest"

import { runHook } from "../../hook-harness.ts"

const HOOK = resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks", "symbol-precheck.ts")
const REPO_ROOT = String(repoRootPath())

describe("containedNameCandidates", () => {
	it("yields the shorter name an affix was added to", () => {
		expect(containedNameCandidates("readPackageJSONFile")).toContain("readPackageJSON")
		expect(containedNameCandidates("readWorkspaceDirectories")).toContain("workspaceDirectories")
	})

	it("keeps an acronym whole and lowercases it when it leads", () => {
		expect(containedNameCandidates("readJSONManifest")).toContain("jsonManifest")
	})

	it("attaches digits to the capitals they follow, and never heads a name with one", () => {
		const candidates = containedNameCandidates("getH3CellIndex")

		expect(candidates).toContain("h3Cell")
		expect(candidates.some((candidate) => /^\d/u.test(candidate))).toBe(false)
	})

	it("excludes the whole name and anything shorter than the floor", () => {
		const candidates = containedNameCandidates("readPackageJSON")

		expect(candidates).not.toContain("readPackageJSON")
		expect(candidates).not.toContain("read")
	})

	it("takes a floor, so the threshold is measurable rather than asserted", () => {
		expect(containedNameCandidates("readPackageJSON", 1)).toContain("read")
		expect(containedNameCandidates("readPackageJSON", 3)).toEqual([])
	})

	it("is one-directional: a shorter name does not report the longer one", () => {
		expect(containedNameCandidates("workspaceDirectories")).not.toContain("readWorkspaceDirectories")
	})
})

describe("the precheck over the tree", () => {
	function contextFor(declaration: string): string {
		const output = runHook(HOOK, {
			hook_event_name: "PreToolUse",
			tool_name: "Write",
			cwd: REPO_ROOT,
			tool_input: { file_path: `${REPO_ROOT}packages/core/lib/fs/probe.ts`, content: declaration },
		})

		return output.hookSpecificOutput?.additionalContext ?? ""
	}

	it("reports the shorter existing name, and says which written name contains it", () => {
		const context = contextFor("export async function readPackageJSONFile(x: string): Promise<void> {}\n")

		expect(context).toContain("readPackageJSON")
		expect(context).toContain("the name inside your readPackageJSONFile")
		expect(context).toContain("packages/core/lib/module/resolve-from.ts")
	})

	it("stays silent for a name with no home, near or exact", () => {
		expect(contextFor("export function tessellateHexBins(x: string) {}\n")).toBe("")
	})
})

describe("formatFindings", () => {
	it("labels a contained name only when a written name spells it out", () => {
		const findings = [{ name: "readPackageJSON", sites: [{ file: "a.ts", line: 1, exported: true, text: "x" }] }]

		expect(formatFindings(findings, ["readPackageJSONFile"])).toContain("the name inside your readPackageJSONFile")
		expect(formatFindings(findings, ["readPackageJSON"])).not.toContain("the name inside")
	})
})
