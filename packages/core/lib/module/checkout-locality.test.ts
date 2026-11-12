// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The locality reading against this checkout and against scratch trees marked
 *   by a `.git` file, the shape a worktree's root has.
 *
 *   The integration test runs the guard in a real worktree without node_modules.
 */

import { realPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import {
	assertCheckoutLocality,
	CheckoutLocalityError,
	enclosingWorkingTree,
	NodeModulesState,
	readCheckoutLocality,
} from "#module/checkout-locality"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A scratch tree whose root holds a worktree-style `.git` file and a nested source directory.
 */
async function scratchTree(): Promise<{ root: string; source: string }> {
	const scratch = fixtures.use(await temporaryDirectory("checkout-locality-")).path
	const root = resolvePath(await realPath(scratch), "tree")
	const source = resolvePath(root, "lib", "tool")

	await writeLocalTextFile("gitdir: /nowhere/.git/worktrees/scratch\n", resolvePath(root, ".git"))
	await makeDirectories(source)

	return { root, source }
}

describe("readCheckoutLocality", () => {
	it("reports this checkout as running on its own packages", async () => {
		const locality = await readCheckoutLocality(import.meta.dirname)
		const checkout = await realPath(repoRootPath())

		expect(locality).toMatchObject({ entryTree: checkout, loadedTree: checkout, local: true })
		await expect(assertCheckoutLocality(import.meta.dirname)).resolves.toBeUndefined()
	})

	it("reports a tree with no node_modules that loaded this checkout's core", async () => {
		const { root, source } = await scratchTree()
		const locality = await readCheckoutLocality(source)

		expect(locality).toMatchObject({
			entryTree: root,
			loadedTree: await realPath(repoRootPath()),
			nodeModules: { state: NodeModulesState.Absent, target: null },
			local: false,
		})

		const refusal = await assertCheckoutLocality(source).catch((error: unknown) => error)

		expect(refusal).toBeInstanceOf(CheckoutLocalityError)
		expect((refusal as Error).message).toContain(`${root} has no node_modules`)
		expect((refusal as Error).message).toContain(`Run \`yarn install\` in ${root}.`)
	})

	it("names the target of a node_modules link", async () => {
		const { root, source } = await scratchTree()
		const target = `${root}-install`

		await makeDirectories(target)
		await createSymbolicLink(target, resolvePath(root, "node_modules"))

		const locality = await readCheckoutLocality(source)

		expect(locality?.nodeModules).toEqual({ state: NodeModulesState.Link, target })
		await expect(assertCheckoutLocality(source)).rejects.toThrow(`${root}/node_modules is a link to ${target}`)
	})
})

describe("enclosingWorkingTree", () => {
	it("finds the nearest ancestor holding a .git entry", async () => {
		const { root, source } = await scratchTree()

		await expect(enclosingWorkingTree(source)).resolves.toBe(root)
		await expect(enclosingWorkingTree(root)).resolves.toBe(root)
	})
})
