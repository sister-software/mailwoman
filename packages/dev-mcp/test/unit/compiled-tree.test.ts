/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertCompiledFresh, checkCompiledFreshness } from "@mailwoman/dev-mcp/compiled-tree"
import { FINGERPRINTED_WORKSPACES } from "@mailwoman/dev-mcp/tree-fingerprint"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const roots: string[] = []

function checkout(): { root: string; workspace: string } {
	const root = mkdtempSync(join(tmpdir(), "mwdev-compiled-"))

	roots.push(root)

	const workspace = join(root, FINGERPRINTED_WORKSPACES[0])

	mkdirSync(join(workspace, "out"), { recursive: true })

	return { root, workspace }
}

function touch(path: string, offsetMs: number): void {
	const when = new Date(Date.now() + offsetMs)

	utimesSync(path, when, when)
}

afterAll(() => {
	for (const root of roots) {
		rmSync(root, { recursive: true, force: true })
	}
})

describe("checkCompiledFreshness", () => {
	it("passes when the compiled output is newer than source", () => {
		const { root, workspace } = checkout()

		writeFileSync(join(workspace, "thing.ts"), "export const x = 1\n")
		writeFileSync(join(workspace, "out", "thing.js"), "export const x = 1\n")
		touch(join(workspace, "thing.ts"), -60_000)
		touch(join(workspace, "out", "thing.js"), 0)

		expect(checkCompiledFreshness(root).fresh).toBe(true)
	})

	it("refuses when source is newer, and says how to fix it", () => {
		const { root, workspace } = checkout()

		writeFileSync(join(workspace, "thing.ts"), "export const x = 2\n")
		writeFileSync(join(workspace, "out", "thing.js"), "export const x = 1\n")
		touch(join(workspace, "out", "thing.js"), -60_000)
		touch(join(workspace, "thing.ts"), 0)

		const freshness = checkCompiledFreshness(root)

		expect(freshness.fresh).toBe(false)
		expect(freshness.reason).toContain("yarn compile")
		// It must say WHY this matters, not merely that it is stale: the gauntlet would report a verdict, not an error.
		expect(freshness.reason).toContain("grade code you have replaced")
		expect(() => assertCompiledFresh(root)).toThrow(/yarn compile/)
	})

	it("distinguishes never-compiled from stale", () => {
		const { root, workspace } = checkout()

		writeFileSync(join(workspace, "thing.ts"), "export const x = 1\n")

		expect(checkCompiledFreshness(root).reason).toContain("No compiled output found")
	})

	it("ignores emitted .d.ts on the source side, so a compile is not an edit", () => {
		// Declaration output lands in out/ and is newer than everything by construction. Counting it as source would
		// make the guard permanently unsatisfiable.
		const { root, workspace } = checkout()

		writeFileSync(join(workspace, "thing.ts"), "export const x = 1\n")
		writeFileSync(join(workspace, "out", "thing.js"), "export const x = 1\n")
		writeFileSync(join(workspace, "out", "thing.d.ts"), "export declare const x: number\n")
		touch(join(workspace, "thing.ts"), -60_000)
		touch(join(workspace, "out", "thing.js"), 0)
		touch(join(workspace, "out", "thing.d.ts"), 30_000)

		expect(checkCompiledFreshness(root).fresh).toBe(true)
	})

	it.each(["thing.test.ts", "thing.test.tsx"])("ignores non-emitting colocated test source %s", (testName) => {
		const { root, workspace } = checkout()
		const source = join(workspace, "thing.ts")
		const compiled = join(workspace, "out", "thing.js")

		writeFileSync(source, "export const x = 1\n")
		writeFileSync(compiled, "export const x = 1\n")
		writeFileSync(join(workspace, testName), "export const testOnly = true\n")
		touch(source, -60_000)
		touch(compiled, 0)
		touch(join(workspace, testName), 30_000)

		const freshness = checkCompiledFreshness(root)

		expect(freshness.fresh).toBe(true)
		expect(freshness.newestSource?.path).toBe(source)
	})

	it("ignores the workspace-root test tree excluded by tsconfig", () => {
		const { root, workspace } = checkout()
		const source = join(workspace, "thing.ts")
		const compiled = join(workspace, "out", "thing.js")
		const testHelper = join(workspace, "test", "unit", "helper.ts")

		mkdirSync(join(workspace, "test", "unit"), { recursive: true })
		writeFileSync(source, "export const x = 1\n")
		writeFileSync(compiled, "export const x = 1\n")
		writeFileSync(testHelper, "export const helper = true\n")
		touch(source, -60_000)
		touch(compiled, 0)
		touch(testHelper, 30_000)

		const freshness = checkCompiledFreshness(root)

		expect(freshness.fresh).toBe(true)
		expect(freshness.newestSource?.path).toBe(source)
	})

	it.each(["debug-view/test/input-probe.ts", "thing.spec.ts", "contest/thing.ts"])(
		"keeps emitting source %s in the freshness comparison",
		(sourcePath) => {
			const { root, workspace } = checkout()
			const source = join(workspace, sourcePath)
			const compiled = join(workspace, "out", "thing.js")

			mkdirSync(join(source, ".."), { recursive: true })
			writeFileSync(source, "export const x = 2\n")
			writeFileSync(compiled, "export const x = 1\n")
			touch(compiled, -60_000)
			touch(source, 0)

			const freshness = checkCompiledFreshness(root)

			expect(freshness.fresh).toBe(false)
			expect(freshness.newestSource?.path).toBe(source)
		}
	)
})
