/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the third-party notices check against temporary trees of notice copies and derived modules.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { thirdPartyNoticesCheck } from "@mailwoman/repo-health/checks/third-party-notices"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * The MIT permission sentence that a shipped copy must carry.
 *
 * The sentence is wrapped across two blockquote lines to test that the check matches through a line break.
 */
const PERMISSION_NOTICE = [
	"> The above copyright notice and this permission notice shall be included in all copies",
	"> or substantial portions of the Software.",
].join("\n")

/**
 * Builds a notice that lists the given module paths and ends with the permission notice.
 */
function notice(modules: readonly string[]): string {
	return `# Third-Party Notices\n\nDerived: ${modules.join(", ")}.\n\n${PERMISSION_NOTICE}\n`
}

/**
 * This module header records the Pelias derivation.
 */
const DERIVED_SOURCE = `/**
 * @copyright Sister Software
 *
 *   Derived from Pelias Parser, MIT, copyright (c) 2019 Pelias Contributors.
 */
export const x = 1
`

/**
 * This module header records only the first-party copyright.
 */
const UNMARKED_SOURCE = `/**
 * @copyright Sister Software
 */
export const x = 1
`

async function plant(files: Record<string, string>) {
	const root = fixtures.use(await temporaryDirectory("third-party-notices-")).path

	for (const [file, text] of Object.entries(files)) {
		await writeLocalTextFile(text, root(file))
	}

	return { repoRoot: root.toString(), trackedFiles: Object.keys(files) }
}

/**
 * Builds a valid tree in which all three notice copies list one module whose header records the derivation.
 */
function agreeingTree(overrides: Record<string, string> = {}) {
	return {
		"THIRD_PARTY_NOTICES.md": notice(["lib/tokenization/Graph.ts"]),
		"docs/THIRD_PARTY_NOTICES.md": notice(["lib/tokenization/Graph.ts"]),
		"packages/core/THIRD_PARTY_NOTICES.md": notice(["lib/tokenization/Graph.ts"]),
		"packages/core/lib/tokenization/Graph.ts": DERIVED_SOURCE,
		...overrides,
	}
}

describe("thirdPartyNoticesCheck", () => {
	it("accepts three copies that name the same module, whose header records the derivation", async () => {
		expect(await thirdPartyNoticesCheck.run(await plant(agreeingTree()))).toEqual([])
	})

	it("reports a copy that omits a module the others name", async () => {
		const context = await plant(agreeingTree({ "docs/THIRD_PARTY_NOTICES.md": notice([]) }))

		const diagnostics = await thirdPartyNoticesCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/omits lib\/tokenization\/Graph\.ts/u)
		expect(diagnostics[0]?.file).toBe("docs/THIRD_PARTY_NOTICES.md")
	})

	it("reports a copy that names a module the others do not", async () => {
		const context = await plant(
			agreeingTree({
				"packages/core/THIRD_PARTY_NOTICES.md": notice(["lib/tokenization/Graph.ts", "lib/tokenization/Solver.ts"]),
			})
		)

		const diagnostics = await thirdPartyNoticesCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/names lib\/tokenization\/Solver\.ts as MIT-derived/u)
	})

	it("reports a named module that no longer exists at that path", async () => {
		const { "packages/core/lib/tokenization/Graph.ts": _moved, ...tree } = agreeingTree()

		const diagnostics = await thirdPartyNoticesCheck.run(await plant(tree))

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/no file exists at packages\/core\/lib\/tokenization\/Graph\.ts/u)
	})

	it("reports a named module whose header does not record the derivation", async () => {
		const context = await plant(agreeingTree({ "packages/core/lib/tokenization/Graph.ts": UNMARKED_SOURCE }))

		const diagnostics = await thirdPartyNoticesCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/its header does not say so/u)
		expect(diagnostics[0]?.file).toBe("packages/core/lib/tokenization/Graph.ts")
	})

	it("reports a shipped copy that omits the MIT permission notice", async () => {
		const context = await plant(
			agreeingTree({
				"packages/core/THIRD_PARTY_NOTICES.md":
					"# Third-Party Notices\n\nDerived: lib/tokenization/Graph.ts. See the MIT license upstream.\n",
			})
		)

		const diagnostics = await thirdPartyNoticesCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/does not reproduce the MIT permission notice/u)
	})
})
