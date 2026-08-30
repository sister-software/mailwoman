/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import {
	extractDeclaredSymbols,
	findDeclarations,
	formatFindings,
	readWriteIntent,
	searchDeclarations,
	selectReportable,
	type DeclarationSite,
} from "@mailwoman/dev-mcp/symbol-index"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A miniature repository: one exported home, one deliberate local copy, one nested decoy.
 */
async function seedFixture(): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mw-symbol-index-")).path

	await makeDirectories(join(root, "packages", "core", "utils"))
	await makeDirectories(join(root, "packages", "api-kit"))

	await writeLocalTextFile(
		"/** `p` in [0, 100]. */\nexport function percentile(xs: readonly number[], p: number): number | null {\n\treturn null\n}\n",
		join(root, "packages", "core", "utils", "stats.ts")
	)

	await writeLocalTextFile(
		"/** Deliberately NOT core's. */\nfunction percentile(sorted: number[], p: number): number {\n\tfunction unreachable() {}\n\treturn 0\n}\n",
		join(root, "packages", "api-kit", "metrics.ts")
	)

	await writeLocalTextFile(
		"export function percentile(sortedAsc: readonly number[], p: number): number {\n\treturn 0\n}\n",
		join(root, "packages", "api-kit", "panel.tsx")
	)

	return root
}

const FIXTURE_ROOT = await seedFixture()

describe("extractDeclaredSymbols", () => {
	it("finds a top-level function declaration", () => {
		expect(extractDeclaredSymbols("export function percentile(xs: number[], p: number) {}")).toEqual(["percentile"])
	})

	it("finds an arrow constant, which carries as much duplicated logic as a function does", () => {
		expect(extractDeclaredSymbols("export const haversineKm = (a: Point, b: Point) => 0")).toEqual(["haversineKm"])
	})

	it("ignores an indented declaration, because a nested scope is not reusable", () => {
		const source = ["export function outer() {", "\tfunction inner() {}", "\tconst nested = () => 0", "}"].join("\n")

		expect(extractDeclaredSymbols(source)).toEqual(["outer"])
	})

	it("ignores a constant that is not a function", () => {
		// A duplicated table or literal is a different problem with a different answer; reporting them would bury the
		// duplicated LOGIC this exists to surface.
		expect(extractDeclaredSymbols('const MAX_SAMPLES = 1024\nconst NAME = "x"')).toEqual([])
	})
})

describe("findDeclarations", () => {
	it("reports every declaration site with its export status", () => {
		const found = findDeclarations(["percentile"], { cwd: FIXTURE_ROOT })
		const sites = found.get("percentile") ?? []

		expect(sites.map((site) => [site.file, site.line, site.exported])).toEqual([
			["packages/api-kit/metrics.ts", 2, false],
			["packages/core/utils/stats.ts", 2, true],
		])
	})

	it("does not report a nested declaration", () => {
		// `unreachable` sits inside api-kit's `percentile`. Nobody can import it, so nobody can duplicate it.
		expect(findDeclarations(["unreachable"], { cwd: FIXTURE_ROOT }).get("unreachable")).toBeUndefined()
	})

	it("returns no entry for a name nothing declares", () => {
		expect(findDeclarations(["thereIsNoSuchSymbol"], { cwd: FIXTURE_ROOT }).size).toBe(0)
	})

	it("does not search .tsx, whose components are a different reuse question", () => {
		// Ripgrep's own `ts` file type covers `*.tsx`, so this has to be excluded deliberately rather than assumed.
		const files = (findDeclarations(["percentile"], { cwd: FIXTURE_ROOT }).get("percentile") ?? []).map(
			(each) => each.file
		)

		expect(files).not.toContain("packages/api-kit/panel.tsx")
	})
})

describe("searchDeclarations", () => {
	it("matches a name by substring, case-insensitively", () => {
		const names = searchDeclarations("CENTIL", { cwd: FIXTURE_ROOT }).map((finding) => finding.name)

		expect(names).toEqual(["percentile"])
	})

	it("returns every site of a matched name", () => {
		const [finding] = searchDeclarations("percentile", { cwd: FIXTURE_ROOT })

		expect(finding?.sites.map((each) => each.file)).toEqual([
			"packages/api-kit/metrics.ts",
			"packages/core/utils/stats.ts",
		])
	})

	it("returns an empty list rather than throwing when nothing matches", () => {
		expect(searchDeclarations("thereIsNoSuchSymbol", { cwd: FIXTURE_ROOT })).toEqual([])
	})
})

describe("readWriteIntent", () => {
	it("reads the whole file from a Write", () => {
		const intent = readWriteIntent({
			tool_name: "Write",
			tool_input: { file_path: "/repo/packages/foo/new.ts", content: "export function f() {}" },
		})

		expect(intent).toEqual({ filePath: "/repo/packages/foo/new.ts", source: "export function f() {}" })
	})

	it("reads only the replacement text from an Edit", () => {
		// The surrounding file is not the author's current intent, and scanning it would report every declaration the
		// file already has against itself.
		const intent = readWriteIntent({
			tool_name: "Edit",
			tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: "function percentile() {}" },
		})

		expect(intent).toEqual({ filePath: "/repo/a.ts", source: "function percentile() {}" })
	})

	it("ignores a tool that writes nothing", () => {
		expect(readWriteIntent({ tool_name: "Bash", tool_input: { command: "ls" } })).toBeNull()
	})

	it("ignores a malformed payload rather than throwing", () => {
		// A hook that throws on an unexpected payload becomes a broken editor, not a broken hint.
		expect(readWriteIntent({ tool_name: "Write", tool_input: {} })).toBeNull()
		expect(readWriteIntent(null)).toBeNull()
	})
})

describe("formatFindings", () => {
	it("shows each site with its signature and which one is importable", () => {
		const text = formatFindings([
			{
				name: "percentile",
				sites: [
					{
						file: "packages/core/utils/stats.ts",
						line: 12,
						exported: true,
						text: "export function percentile(xs: readonly number[], p: number): number | null {",
					},
					{
						file: "packages/api-kit/metrics.ts",
						line: 60,
						exported: false,
						text: "function percentile(sorted: number[], p: number): number {",
					},
				],
			},
		])

		expect(text).toContain("packages/core/utils/stats.ts:12")
		expect(text).toContain("packages/api-kit/metrics.ts:60")
		expect(text).toContain("p: number): number | null")
		// The export status is the difference between "you could import this" and "someone already decided not to".
		expect(text).toContain("exported")
	})

	it("says the existing implementation may be the wrong one to reuse", () => {
		// api-kit's `percentile` takes a FRACTION where core's takes [0, 100]. A hint phrased as an instruction would
		// have an author collapse those two and silently change a unit.
		const text = formatFindings([
			{ name: "percentile", sites: [declarationSite("packages/core/utils/stats.ts", true, 12)] },
		])

		expect(text.toLowerCase()).toContain("may")
	})

	it("returns nothing when there is nothing to report", () => {
		expect(formatFindings([])).toBe("")
	})
})

function declarationSite(file: string, exported: boolean, line = 1): DeclarationSite {
	return { file, line, exported, text: `${exported ? "export " : ""}function x() {}` }
}

describe("selectReportable", () => {
	it("reports a name that already has an exported home", () => {
		const found = new Map([
			[
				"percentile",
				[declarationSite("packages/api-kit/metrics.ts", false), declarationSite("packages/core/utils/stats.ts", true)],
			],
		])

		expect(selectReportable(found, { writingFile: "packages/foo/new.ts" }).map((finding) => finding.name)).toEqual([
			"percentile",
		])
	})

	it("suppresses a name that is declared everywhere and exported nowhere", () => {
		// `main` had 34 declaration sites at the time this rule was chosen and not one of them is importable. A stoplist
		// would have to name it; this rule derives it, which is the difference that keeps the rule from going stale.
		const found = new Map([["main", [declarationSite("scripts/a.ts", false), declarationSite("scripts/b.ts", false)]]])

		expect(selectReportable(found, { writingFile: "scripts/c.ts" })).toEqual([])
	})

	it("does not let a declaration report itself", () => {
		const found = new Map([["percentile", [declarationSite("packages/core/utils/stats.ts", true)]]])

		expect(selectReportable(found, { writingFile: "packages/core/utils/stats.ts" })).toEqual([])
	})

	it("drops the edited file from the sites of a name it still reports", () => {
		const found = new Map([
			[
				"percentile",
				[declarationSite("packages/core/utils/stats.ts", true), declarationSite("packages/api-kit/metrics.ts", false)],
			],
		])

		const [finding] = selectReportable(found, { writingFile: "packages/api-kit/metrics.ts" })

		expect(finding?.sites.map((each) => each.file)).toEqual(["packages/core/utils/stats.ts"])
	})
})

describe("a missing ripgrep", () => {
	it("says the search could not run rather than answering zero", () => {
		// Meaning-of-zero: an empty result must mean "searched and found nothing". If the searcher never ran, the
		// caller has to hear that, because a silent zero here reads as "this symbol has no home".
		expect(() => findDeclarations(["percentile"], { cwd: FIXTURE_ROOT, binary: "rg-does-not-exist" })).toThrow(
			/ripgrep/i
		)
	})
})
