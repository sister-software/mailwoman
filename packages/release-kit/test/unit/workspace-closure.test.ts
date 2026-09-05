/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The workspace closure is computed from the manifests, so it follows the dependency graph as it changes.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { GET_STARTED_SEEDS } from "@mailwoman/release-kit/release/smoke-get-started"
import { walkWorkspaceClosure, workspaceDirectories } from "@mailwoman/release-kit/release/workspace-closure"
import { describe, expect, it } from "vitest"

describe("walkWorkspaceClosure", () => {
	it("reaches every workspace the get-started seeds pull in, and nothing outside the root workspaces array", async () => {
		const root = String(repoRootPath())
		const closure = await walkWorkspaceClosure(root, GET_STARTED_SEEDS)
		const all = await workspaceDirectories(root)

		for (const seed of GET_STARTED_SEEDS) {
			expect(closure.has(seed)).toBe(true)
		}

		// Through mailwoman → core → evidence and sqlite: the leaves a hand-kept list forgets first.
		for (const reached of ["@mailwoman/core", "@mailwoman/sqlite", "@mailwoman/evidence"]) {
			expect(closure.get(reached)).toBe(all.get(reached))
		}

		for (const [name, dir] of closure) {
			expect(all.get(name)).toBe(dir)
		}
	})

	it("refuses a seed that names no workspace, rather than packing a shorter closure", async () => {
		await expect(walkWorkspaceClosure(String(repoRootPath()), ["@mailwoman/does-not-exist"])).rejects.toThrow(
			/names no workspace/u
		)
	})
})
