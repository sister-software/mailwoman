/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The name-shadow finder over a planted tree: one true shadow, one marked copy, one generic name, one short name.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { collectRepoContext } from "@mailwoman/repo-health"
import { findPrivateNameShadows, privateNameShadowsCheck } from "@mailwoman/repo-health/checks/private-name-shadows"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function plant(files: Record<string, string>): Promise<{ repoRoot: string; trackedFiles: string[] }> {
	const root = fixtures.use(await temporaryDirectory("shadows-")).path

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(join(root, file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(root, file))
	}

	return { repoRoot: String(root), trackedFiles: Object.keys(files) }
}

describe("findPrivateNameShadows", () => {
	it("reports the private copy of an exported name, and only that", async () => {
		const context = await plant({
			"packages/a/lib/stats.ts": "export function percentile(xs: number[], p: number): number { return xs[p]! }\n",
			"packages/b/lib/metrics.ts": "function percentile(sorted: number[], p: number): number { return sorted[p]! }\n",
			"packages/c/lib/marked.ts":
				"// repo-health-ignore private-name-shadows-export -- no dependency on a; the stream is pinned by fixtures\nfunction percentile(xs: number[]): number { return xs[0]! }\n",
			"packages/d/lib/generic.ts": "export function normalize(s: string): string { return s }\n",
			"packages/e/lib/generic-copy.ts": "function normalize(s: string): string { return s.trim() }\n",
			"packages/f/lib/short.ts": "export function pick(a: number): number { return a }\n",
			"packages/g/lib/short-copy.ts": "function pick(a: number): number { return a + 1 }\n",
			"packages/h/test/unit/x.test.ts": "function percentile(): number { return 0 }\n",
		})

		const shadows = await findPrivateNameShadows(context)

		expect(shadows).toEqual([
			{ file: "packages/b/lib/metrics.ts", line: 1, name: "percentile", exportedIn: ["packages/a/lib/stats.ts"] },
		])

		const diagnostics = await privateNameShadowsCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]!.message).toContain("packages/a/lib/stats.ts")
	})

	it("runs over the current tree without error and agrees with the debt counter's population", async () => {
		const context = await collectRepoContext()
		const shadows = await findPrivateNameShadows(context)

		expect(Array.isArray(shadows)).toBe(true)
		expect(await privateNameShadowsCheck.run(context)).toHaveLength(shadows.length)
	})
})
