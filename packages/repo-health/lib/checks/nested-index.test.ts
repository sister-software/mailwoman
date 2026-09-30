/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { findMisplacedGroupModules, findNestedIndexes, planNestedIndexMoves } from "#checks/nested-index"

describe("nested-index", () => {
	test("renames a nested index and the tests named for it", () => {
		const tracked = [
			"packages/x/lib/index.ts",
			"packages/x/lib/geocode/index.ts",
			"packages/x/lib/geocode/index.test.ts",
			"packages/x/lib/geocode/index.integration.test.ts",
			"packages/x/lib/geocode/session.ts",
		]

		expect(planNestedIndexMoves(findNestedIndexes(tracked))).toEqual([
			{ from: "packages/x/lib/geocode/index.ts", to: "packages/x/lib/geocode.ts" },
			{ from: "packages/x/lib/geocode/index.test.ts", to: "packages/x/lib/geocode.test.ts" },
			{ from: "packages/x/lib/geocode/index.integration.test.ts", to: "packages/x/lib/geocode.integration.test.ts" },
		])
	})

	test("moves a test named for the directory when no module of that name sits beside it", () => {
		const moved = planNestedIndexMoves(
			findNestedIndexes([
				"packages/x/lib/edgar/filings/index.ts",
				"packages/x/lib/edgar/filings/filings.test.ts",
				"packages/x/lib/edgar/cik/index.ts",
				"packages/x/lib/edgar/cik/cik.ts",
				"packages/x/lib/edgar/cik/cik.test.ts",
			])
		)

		expect(moved).toEqual([
			{ from: "packages/x/lib/edgar/cik/index.ts", to: "packages/x/lib/edgar/cik.ts" },
			{ from: "packages/x/lib/edgar/filings/index.ts", to: "packages/x/lib/edgar/filings.ts" },
			{ from: "packages/x/lib/edgar/filings/filings.test.ts", to: "packages/x/lib/edgar/filings.test.ts" },
		])
	})

	test("keeps index modules in the command tree and moves a misplaced group command back", () => {
		const tracked = [
			"packages/mailwoman/cli/commands/data/index.tsx",
			"packages/mailwoman/cli/commands/data/pull.tsx",
			"packages/mailwoman/cli/commands/eval.tsx",
			"packages/mailwoman/cli/commands/eval.test.tsx",
			"packages/mailwoman/cli/commands/eval/gauntlet.tsx",
			"packages/mailwoman/cli/commands/parse.tsx",
		]

		expect(findNestedIndexes(tracked)).toEqual([])

		expect(planNestedIndexMoves([], findMisplacedGroupModules(tracked))).toEqual([
			{ from: "packages/mailwoman/cli/commands/eval.tsx", to: "packages/mailwoman/cli/commands/eval/index.tsx" },
			{
				from: "packages/mailwoman/cli/commands/eval.test.tsx",
				to: "packages/mailwoman/cli/commands/eval/index.test.tsx",
			},
		])
	})

	test("keeps the package root index and ignores source roots outside lib/", () => {
		expect(findNestedIndexes(["packages/x/lib/index.ts", "docs/src/pages/index.tsx"])).toEqual([])
	})

	test("reports a taken destination and plans no move for it", () => {
		const tracked = ["packages/x/lib/map/index.tsx", "packages/x/lib/map.tsx"]
		const indexes = findNestedIndexes(tracked)

		expect(indexes.map((entry) => entry.collision)).toEqual(["packages/x/lib/map.tsx"])
		expect(planNestedIndexMoves(indexes)).toEqual([])
	})
})
