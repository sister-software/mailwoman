/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { type CIReplay, compareCIReplays, failedTestFiles, type ReplaySelection } from "#repo-health/ci/replay"

function selection(sha: string, fastFiles: string[], full = false): ReplaySelection {
	return { sha, base: `${sha}^`, changed: 1, full, fastFiles, slowFiles: [] }
}

function replay(commits: ReplaySelection[], failures: CIReplay["failures"] = []): CIReplay {
	return { checkout: "c", ref: "r", commits, failures, unchecked: [] }
}

describe("failedTestFiles", () => {
	it("reads each failing test file once from a Vitest log, through escape-byte and caret-notation colour codes", () => {
		const log = [
			"unit-slow\tTest (slow)\t2026-11-10T05:16:50Z \u001B[41m\u001B[1m FAIL \u001B[22m\u001B[49m packages/corpus/lib/build.integration.test.ts > resume > refuses",
			"unit-fast\tTest (fast)\t2026-11-10T05:16:51Z  FAIL  lib/repo-health/ci/scope.test.ts > visits cycles",
			"unit-fast\tTest (fast)\t2026-11-10T05:16:52Z  FAIL  lib/repo-health/ci/scope.test.ts > selects consumers",
			"unit-slow\tTest (slow)\t2026-11-10T05:16:53Z ^[[41m^[[1m FAIL ^[[22m^[[49m packages/core/lib/a.integration.test.ts^[[2m > ^[[22mx",
			"verdict: FAIL (max-degraded 0)",
		].join("\n")

		expect(failedTestFiles(log)).toEqual([
			"lib/repo-health/ci/scope.test.ts",
			"packages/core/lib/a.integration.test.ts",
			"packages/corpus/lib/build.integration.test.ts",
		])
	})
})

describe("compareCIReplays", () => {
	it("pairs commits, classifies each pair, and leaves full selections out of the sums", () => {
		const before = replay([
			selection("a", ["x.test.ts", "y.test.ts"]),
			selection("b", ["x.test.ts"]),
			selection("c", ["x.test.ts"]),
			selection("d", [], true),
		])

		const after = replay([
			selection("a", ["x.test.ts"]),
			selection("b", ["x.test.ts", "z.test.ts"]),
			selection("c", ["x.test.ts"]),
			selection("d", [], true),
		])

		const comparison = compareCIReplays(before, after)

		expect(comparison).toMatchObject({
			commits: 4,
			fullBefore: 1,
			fullAfter: 1,
			selectedBefore: 4,
			selectedAfter: 4,
			narrower: 1,
			wider: 1,
			mixed: 0,
			equal: 1,
		})

		expect(comparison.rows).toEqual([
			{ sha: "a", before: 2, after: 1, onlyBefore: ["y.test.ts"], onlyAfter: [] },
			{ sha: "b", before: 1, after: 2, onlyBefore: [], onlyAfter: ["z.test.ts"] },
		])
	})

	it("reports whether each rule selects each recorded failing test for its push", () => {
		const failures = (fastFiles: string[]): CIReplay["failures"] => [
			{ runID: 7, sha: "a", base: "p", failedTests: ["x.test.ts", "y.test.ts"], selection: selection("a", fastFiles) },
		]

		const comparison = compareCIReplays(
			replay([selection("a", [])], failures(["x.test.ts", "y.test.ts"])),
			replay([selection("a", [])], failures(["x.test.ts"]))
		)

		expect(comparison.failures).toEqual([
			{ runID: 7, sha: "a", file: "x.test.ts", selectedBefore: true, selectedAfter: true },
			{ runID: 7, sha: "a", file: "y.test.ts", selectedBefore: true, selectedAfter: false },
		])
	})

	it("refuses to pair replays of different histories", () => {
		expect(() => compareCIReplays(replay([selection("a", [])]), replay([selection("b", [])]))).toThrow(
			"different commits"
		)
	})
})
