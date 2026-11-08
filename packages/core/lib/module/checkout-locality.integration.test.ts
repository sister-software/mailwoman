// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The checkout-locality guard in a real git worktree of this repository that has no node_modules.
 *
 *   The worktree sits in a scratch directory whose `node_modules` links to this checkout's install, the layout a
 *   worktree under `.claude/worktrees/<name>` has below the primary checkout. Node's upward walk then resolves
 *   `@mailwoman/core` from this checkout. The guard exists to refuse that resolution.
 *
 *   The worktree is added without a checkout and given the current working-tree copies of the files under test,
 *   so the test exercises uncommitted source rather than `HEAD`.
 */

import { realPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { copyFileTo, createSymbolicLink, removePath, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { gitSync } from "@mailwoman/core/git"
import { parseJSONStrict } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { NodeModulesState, type CheckoutLocality } from "#module/checkout-locality"

const fixtures = new AsyncDisposableStack()

let checkout: string
let parent: string
let worktree: string

/**
 * Prints what a script in the worktree sees: the repository root its paths
 * and writes use, and the locality reading.
 */
const PROBE = `import { readCheckoutLocality } from "@mailwoman/core/module/checkout-locality"
import { repoRootPath } from "@mailwoman/core/paths"

console.log(JSON.stringify({ repoRoot: repoRootPath(), locality: await readCheckoutLocality(import.meta.dirname) }))
`

beforeAll(async () => {
	checkout = await realPath(repoRootPath())
	parent = resolvePath(await realPath(fixtures.use(await temporaryDirectory("checkout-locality-")).path), "parent")
	worktree = resolvePath(parent, "worktree")

	gitSync(["worktree", "add", "--detach", "--no-checkout", worktree, "HEAD"], { cwd: checkout })

	fixtures.defer(() => {
		gitSync(["worktree", "remove", "--force", worktree], { cwd: checkout })
	})

	for (const file of ["package.json", "lib/ops-cli/cli.ts"]) {
		await copyFileTo(resolvePath(checkout, file), resolvePath(worktree, file))
	}

	await writeLocalTextFile(PROBE, resolvePath(worktree, "probe.ts"))

	// The install above the worktree, standing in for the primary checkout's.
	await createSymbolicLink(resolvePath(checkout, "node_modules"), resolvePath(parent, "node_modules"))
}, 60_000)

afterAll(() => fixtures.disposeAsync())

/**
 * Run a script in the worktree with this process's Node, answering its exit status and output.
 */
async function runInWorktree(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await runFile(process.execPath, args, { cwd: worktree })

		return { status: 0, stdout, stderr }
	} catch (error) {
		if (!isProcessError(error)) throw error

		return { status: Number(error.code), stdout: error.stdout, stderr: error.stderr }
	}
}

describe("a worktree without node_modules", () => {
	it("resolves this checkout's core, so repository paths and writes name this checkout", async () => {
		const { status, stdout, stderr } = await runInWorktree("probe.ts")

		expect(stderr).toBe("")
		expect(status).toBe(0)

		const { repoRoot, locality } = parseJSONStrict<{ repoRoot: string; locality: CheckoutLocality }>(stdout)

		expect(repoRoot).toBe(checkout)

		expect(locality).toEqual({
			entryTree: worktree,
			loadedTree: checkout,
			nodeModules: { state: NodeModulesState.Absent, target: null },
			local: false,
		})
	})

	it("is refused by mwops before any operation loads", async () => {
		const { status, stdout, stderr } = await runInWorktree("lib/ops-cli/cli.ts", "checkout")

		expect(status).toBe(1)
		expect(stdout).toBe("")
		expect(stderr).toContain(`This entry point is in ${worktree} but runs on the packages of ${checkout}.`)
		expect(stderr).toContain(`${worktree} has no node_modules`)
		expect(stderr).toContain(`Run \`yarn install\` in ${worktree}.`)
	})

	it("is refused when its node_modules links to another checkout's install", async () => {
		const link = resolvePath(worktree, "node_modules")

		await createSymbolicLink(resolvePath(parent, "node_modules"), link)

		try {
			const { status, stderr } = await runInWorktree("lib/ops-cli/cli.ts", "checkout")

			expect(status).toBe(1)
			expect(stderr).toContain(`${link} is a link to ${resolvePath(checkout, "node_modules")}`)
			expect(stderr).toContain(`Remove the node_modules link and run \`yarn install\` in ${worktree}.`)
		} finally {
			// `rm` removes the link itself, never the install it points at.
			await removePath(link)
		}
	})
})
