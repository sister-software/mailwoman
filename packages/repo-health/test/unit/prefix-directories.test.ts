/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The sibling-prefix contract: three or more children sharing a hyphen prefix become a directory, and the two
 *   kinds of name that are contracts rather than layout stay put.
 */

import { collectRepoContext } from "@mailwoman/repo-health"
import {
	findPrefixGroups,
	planPrefixMoves,
	prefixDirectoriesCheck,
} from "@mailwoman/repo-health/checks/prefix-directories"
import { describe, expect, test } from "vitest"

const ADAPTERS = "packages/corpus/lib/adapters"

describe("findPrefixGroups", () => {
	test("groups three siblings and leaves a pair alone", () => {
		const groups = findPrefixGroups([
			`${ADAPTERS}/state-hi-schools/adapter.ts`,
			`${ADAPTERS}/state-ia-contractors/adapter.ts`,
			`${ADAPTERS}/state-ny-notaries/adapter.ts`,
			`${ADAPTERS}/juso-kr/adapter.ts`,
			`${ADAPTERS}/localdata-kr/adapter.ts`,
			`${ADAPTERS}/index.ts`,
		])

		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({ directory: ADAPTERS, prefix: "state" })

		expect(groups[0]?.members.map((member) => member.name)).toEqual([
			"state-hi-schools",
			"state-ia-contractors",
			"state-ny-notaries",
		])
	})

	test("counts a file and a directory as siblings of one family", () => {
		const groups = findPrefixGroups([
			`${ADAPTERS}/wof-admin-jp/adapter.ts`,
			`${ADAPTERS}/wof-admin-json/adapter.ts`,
			`${ADAPTERS}/wof-json-rows.ts`,
		])

		expect(groups[0]?.members.map((member) => `${member.name}:${member.kind}`)).toEqual([
			"wof-admin-jp:directory",
			"wof-admin-json:directory",
			"wof-json-rows.ts:file",
		])
	})

	test("a name with no hyphen heads a family when one shares it, and stands alone otherwise", () => {
		const groups = findPrefixGroups([
			`${ADAPTERS}/geonames/adapter.ts`,
			`${ADAPTERS}/geonames-postal/adapter.ts`,
			`${ADAPTERS}/gnaf/adapter.ts`,
		])

		// `geonames/` heads the family `geonames-postal/` belongs to; `gnaf/` repeats nothing and is untouched.
		expect(groups).toHaveLength(1)
		expect(groups[0]?.members.map((member) => member.name)).toEqual(["geonames", "geonames-postal"])
	})

	test("a head directory stays put while its siblings move into it", () => {
		const tracked = [`${ADAPTERS}/geonames/adapter.ts`, `${ADAPTERS}/geonames-postal/adapter.ts`]

		expect(planPrefixMoves(findPrefixGroups(tracked), tracked)).toEqual([
			{ from: `${ADAPTERS}/geonames-postal/adapter.ts`, to: `${ADAPTERS}/geonames/postal/adapter.ts` },
		])
	})

	test("a head file becomes the directory's index", () => {
		const tracked = ["a/b/reliability.ts", "a/b/reliability-report.ts"]

		expect(planPrefixMoves(findPrefixGroups(tracked), tracked)).toEqual([
			{ from: "a/b/reliability-report.ts", to: "a/b/reliability/report.ts" },
			{ from: "a/b/reliability.ts", to: "a/b/reliability/index.ts" },
		])
	})

	test("never groups workspace directories — the name is the npm package name", () => {
		const tracked = [
			"packages/neural-weights-en-gb/scripts/link-dev-weights.ts",
			"packages/neural-weights-en-us/scripts/link-dev-weights.ts",
			"packages/neural-weights-fr-fr/scripts/link-dev-weights.ts",
		]

		expect(findPrefixGroups(tracked)).not.toEqual([])

		expect(
			findPrefixGroups(tracked, [
				"packages/neural-weights-en-gb",
				"packages/neural-weights-en-us",
				"packages/neural-weights-fr-fr",
			])
		).toEqual([])
	})

	test("never groups a directory carrying no TypeScript — those names belong to someone else", () => {
		expect(
			findPrefixGroups([
				"hf-publish/mailwoman-cjk/README.md",
				"hf-publish/mailwoman-en-us/README.md",
				"hf-publish/mailwoman-tokenizer/README.md",
			])
		).toEqual([])
	})

	test("ignores build output and declarations", () => {
		expect(
			findPrefixGroups([
				"packages/x/out/a-one.d.ts",
				"packages/x/out/a-two.d.ts",
				"packages/x/out/a-three.d.ts",
				"packages/x/lib/index.ts",
			])
		).toEqual([])
	})
})

describe("planPrefixMoves", () => {
	test("expands a directory member into one move per tracked file under it", () => {
		const tracked = [
			`${ADAPTERS}/usgov-nad/adapter.ts`,
			`${ADAPTERS}/usgov-nppes/adapter.ts`,
			`${ADAPTERS}/usgov-nppes/README.md`,
			`${ADAPTERS}/usgov-irs-bmf/adapter.ts`,
		]

		expect(planPrefixMoves(findPrefixGroups(tracked), tracked)).toEqual([
			{ from: `${ADAPTERS}/usgov-irs-bmf/adapter.ts`, to: `${ADAPTERS}/usgov/irs-bmf/adapter.ts` },
			{ from: `${ADAPTERS}/usgov-nad/adapter.ts`, to: `${ADAPTERS}/usgov/nad/adapter.ts` },
			{ from: `${ADAPTERS}/usgov-nppes/adapter.ts`, to: `${ADAPTERS}/usgov/nppes/adapter.ts` },
			{ from: `${ADAPTERS}/usgov-nppes/README.md`, to: `${ADAPTERS}/usgov/nppes/README.md` },
		])
	})

	test("moves a file member to the prefix directory, keeping the rest of its name", () => {
		const tracked = ["a/b/score-one.run.ts", "a/b/score-two.run.ts", "a/b/score-three.run.ts"]

		expect(planPrefixMoves(findPrefixGroups(tracked), tracked).map((move) => move.to)).toEqual([
			"a/b/score/one.run.ts",
			"a/b/score/three.run.ts",
			"a/b/score/two.run.ts",
		])
	})
})

describe("prefixDirectoriesCheck", () => {
	test("reports each group with its directory destination", async () => {
		const diagnostics = await prefixDirectoriesCheck.run({
			repoRoot: ".",
			trackedFiles: [
				`${ADAPTERS}/state-hi-schools/adapter.ts`,
				`${ADAPTERS}/state-ia-contractors/adapter.ts`,
				`${ADAPTERS}/state-ny-notaries/adapter.ts`,
			],
		})

		expect(diagnostics).toEqual([
			expect.objectContaining({
				severity: "error",
				// A directory member's diagnostic names the directory, not a file inside it.
				file: `${ADAPTERS}/state-hi-schools`,
				message: expect.stringContaining(`${ADAPTERS}/state/`),
			}),
		])
	})

	test("reports nothing on the current tree", async () => {
		const context = await collectRepoContext()

		expect(await prefixDirectoriesCheck.run(context)).toEqual([])
	})
})
