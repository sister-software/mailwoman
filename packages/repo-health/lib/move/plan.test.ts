/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A module-move fixture that covers the path shapes in a corpus recipe move.
 *   The fixture includes an `imports` map for `#recipes/*` and an `exports` map used by a test file.
 *   A third file contains a relative import. The moved file also contains a relative import.
 *   Its depth changes after the move.
 *
 *   The workspace is a real git checkout because `applyModuleMoves` renames files with `git mv`.
 *   The index records each rename, so reviewers see moved files instead of a deletion beside an addition.
 */

import { readLocalTextFile, realPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { git } from "@mailwoman/core/git"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

import type { RepoContext } from "#index"
import { applyModuleMoves } from "#move/apply"
import { planModuleMoves } from "#move/plan"

const PACKAGE = "packages/recipes"

const FILES: Record<string, string> = {
	"package.json": stringifyJSON({ name: "@fixture/root", private: true, workspaces: ["packages/*"] }),
	[`${PACKAGE}/package.json`]: stringifyJSON({
		name: "@fixture/recipes",
		type: "module",
		imports: { "#*": { types: "./out/*.d.ts", node: "./lib/*.ts", default: "./out/*.js" } },
		exports: {
			".": { types: "./out/index.d.ts", node: "./lib/index.ts", default: "./out/index.js" },
			"./recipes/*": { types: "./out/recipes/*.d.ts", node: "./lib/recipes/*.ts", default: "./out/recipes/*.js" },
		},
	}),
	[`${PACKAGE}/lib/scaffold.ts`]: `export interface Recipe {\n\tname: string\n}\n`,
	[`${PACKAGE}/lib/recipes/fr-order.ts`]: [
		`import type { Recipe } from "../scaffold.ts"`,
		``,
		`export const frOrderRecipe: Recipe = { name: "fr-order" }`,
		``,
	].join("\n"),
	[`${PACKAGE}/lib/recipes/fr-fragment.ts`]: [
		`import type { Recipe } from "#scaffold"`,
		``,
		`export const frFragmentRecipe: Recipe = { name: "fr-fragment" }`,
		``,
	].join("\n"),
	[`${PACKAGE}/lib/recipes/index.ts`]: [
		`import { frFragmentRecipe } from "#recipes/fr-fragment"`,
		`import { frOrderRecipe } from "#recipes/fr-order"`,
		``,
		`export const recipes = [frFragmentRecipe, frOrderRecipe]`,
		``,
	].join("\n"),
	[`${PACKAGE}/lib/tools/audit.ts`]: [
		`import { frOrderRecipe } from "../recipes/fr-order.ts"`,
		``,
		`export const audited = frOrderRecipe.name`,
		``,
	].join("\n"),
	[`${PACKAGE}/test/fr-fragment.test.ts`]: [
		`import { frFragmentRecipe } from "@fixture/recipes/recipes/fr-fragment"`,
		``,
		`export const named = frFragmentRecipe.name`,
		``,
	].join("\n"),
}

async function fixture() {
	const directory = await temporaryDirectory("move-plan-")
	// The temp root itself can be a symlink.
	// TypeScript resolves modules to their real paths.
	// The context must use the real root so resolved modules match tracked file paths.
	const repoRoot = await realPath(directory.path)

	for (const [file, content] of Object.entries(FILES)) {
		await writeLocalTextFile(content, resolvePath(repoRoot, file))
	}

	await createSymbolicLink(resolvePath(repoRoot, PACKAGE), resolvePath(repoRoot, "node_modules/@fixture/recipes"))
	await git(["init", "--quiet"], repoRoot)
	await git(["add", "-A", "--", "packages", "package.json"], repoRoot)

	// A rename is detected against a commit rather than against an empty index: with no head,
	// `git mv` still moves the file but `git status` reports an addition.
	await git(
		["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "--quiet", "-m", "fixture"],
		repoRoot
	)

	const context: RepoContext = { repoRoot, trackedFiles: Object.keys(FILES) }

	return directory.moveWith({ context })
}

const MOVES = [
	{ from: `${PACKAGE}/lib/recipes/fr-order.ts`, to: `${PACKAGE}/lib/recipes/fr/order.ts` },
	{ from: `${PACKAGE}/lib/recipes/fr-fragment.ts`, to: `${PACKAGE}/lib/recipes/fr/fragment.ts` },
]

describe("planModuleMoves", () => {
	test("rewrites every family in the family it was written in", async () => {
		await using fixtureDirectory = await fixture()
		const plan = await planModuleMoves(fixtureDirectory.context, MOVES)

		expect(plan.unresolved).toEqual([])

		expect(
			plan.rewrites.map((rewrite) => `${rewrite.file}: ${rewrite.specifier} -> ${rewrite.replacement}`).toSorted()
		).toEqual([
			`${PACKAGE}/lib/recipes/fr/order.ts: ../scaffold.ts -> ../../scaffold.ts`,
			`${PACKAGE}/lib/recipes/index.ts: #recipes/fr-fragment -> #recipes/fr/fragment`,
			`${PACKAGE}/lib/recipes/index.ts: #recipes/fr-order -> #recipes/fr/order`,
			`${PACKAGE}/lib/tools/audit.ts: ../recipes/fr-order.ts -> ../recipes/fr/order.ts`,
			`${PACKAGE}/test/fr-fragment.test.ts: @fixture/recipes/recipes/fr-fragment -> @fixture/recipes/recipes/fr/fragment`,
		])
	})

	test("leaves a specifier the move does not disturb", async () => {
		await using fixtureDirectory = await fixture()
		const plan = await planModuleMoves(fixtureDirectory.context, MOVES)

		// `#scaffold` names the same file from either depth, so a moved file keeps it verbatim.
		expect(plan.rewrites.map((rewrite) => rewrite.specifier)).not.toContain("#scaffold")
	})

	test("reads only the files that could name a moved module", async () => {
		await using fixtureDirectory = await fixture()
		const plan = await planModuleMoves(fixtureDirectory.context, MOVES)

		expect(plan.scanned.tracked).toBe(6)
		expect(plan.scanned.read).toBe(5)
	})
})

describe("applyModuleMoves", () => {
	test("moves the files, rewrites the specifiers, and re-resolves every one", async () => {
		await using fixtureDirectory = await fixture()
		const { context } = fixtureDirectory
		const plan = await planModuleMoves(context, MOVES)
		const result = await applyModuleMoves(context, plan)

		expect(result.verified).toBe(plan.rewrites.length)

		expect(await readLocalTextFile(resolvePath(context.repoRoot, `${PACKAGE}/lib/recipes/index.ts`))).toContain(
			`from "#recipes/fr/order"`
		)

		expect(await readLocalTextFile(resolvePath(context.repoRoot, `${PACKAGE}/test/fr-fragment.test.ts`))).toContain(
			`from "@fixture/recipes/recipes/fr/fragment"`
		)

		expect(await readLocalTextFile(resolvePath(context.repoRoot, `${PACKAGE}/lib/recipes/fr/order.ts`))).toContain(
			`from "../../scaffold.ts"`
		)

		const stdout = await git(["status", "--porcelain"], context.repoRoot)

		// `RM`, not `R `: the index records the rename and the worktree records the
		// specifier rewrite inside the file that moved.
		expect(stdout).toMatch(
			/^RM packages\/recipes\/lib\/recipes\/fr-order\.ts -> packages\/recipes\/lib\/recipes\/fr\/order\.ts$/m
		)

		expect(stdout).toMatch(
			/^R {2}packages\/recipes\/lib\/recipes\/fr-fragment\.ts -> packages\/recipes\/lib\/recipes\/fr\/fragment\.ts$/m
		)
	})

	test("refuses a plan carrying an unresolved specifier", async () => {
		await using fixtureDirectory = await fixture()
		const plan = await planModuleMoves(fixtureDirectory.context, MOVES)

		plan.unresolved.push({ file: "a.ts", specifier: "#nowhere", reason: "test" })

		await expect(applyModuleMoves(fixtureDirectory.context, plan)).rejects.toThrow("no proven replacement")
	})

	test("dry run touches nothing", async () => {
		await using fixtureDirectory = await fixture()
		const { context } = fixtureDirectory
		const plan = await planModuleMoves(context, MOVES)

		expect((await applyModuleMoves(context, plan, { dryRun: true })).dryRun).toBe(true)

		expect(await readLocalTextFile(resolvePath(context.repoRoot, `${PACKAGE}/lib/recipes/index.ts`))).toContain(
			`from "#recipes/fr-order"`
		)
	})
})
