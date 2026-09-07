/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The affix finder and the doc-link finder over planted trees. Both exist because of the same session: a helper
 *   was written twice under a longer name, and a third was implemented from a doc link that named nothing.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { collectRepoContext } from "@mailwoman/repo-health"
import { docLinkTargetsCheck, findDanglingLinks } from "@mailwoman/repo-health/checks/doc-link-targets"
import { exportNameAffixCheck, findAffixPairs } from "@mailwoman/repo-health/checks/export-name-affix"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function plant(files: Record<string, string>): Promise<{ repoRoot: string; trackedFiles: string[] }> {
	const root = fixtures.use(await temporaryDirectory("affix-")).path

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(join(root, file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(root, file))
	}

	return { repoRoot: String(root), trackedFiles: Object.keys(files) }
}

describe("findAffixPairs", () => {
	it("reports a longer name that spells out another package's export", async () => {
		const context = await plant({
			"packages/a/lib/workspaces.ts":
				"export function workspaceDirectories(root: string): string[] { return [root] }\n",
			"packages/b/lib/reader.ts":
				"export function readWorkspaceDirectories(root: string): string[] { return [root] }\n",
		})

		const pairs = await findAffixPairs(context)

		expect(pairs).toEqual([
			{
				file: "packages/b/lib/reader.ts",
				line: 1,
				name: "readWorkspaceDirectories",
				contains: "workspaceDirectories",
				containedIn: ["packages/a/lib/workspaces.ts"],
			},
		])
	})

	it("leaves a family inside one package alone", async () => {
		const context = await plant({
			"packages/a/lib/base.ts": "export function buildPostcodeLocality(cc: string): string { return cc }\n",
			"packages/a/lib/jp.ts": "export function buildPostcodeLocalityJP(cc: string): string { return cc }\n",
		})

		expect(await findAffixPairs(context)).toEqual([])
	})

	it("respects the ignore marker with its reason", async () => {
		const context = await plant({
			"packages/a/lib/home.ts": "export function trackedFiles(root: string): string[] { return [root] }\n",
			"packages/b/lib/copy.ts":
				"// repo-health-ignore export-name-affix -- this workspace carries no dependency on a.\nexport function listTrackedFiles(root: string): string[] { return [root] }\n",
		})

		expect(await findAffixPairs(context)).toEqual([])
	})

	it("needs two shared components, so a single shared word is not a pair", async () => {
		const context = await plant({
			"packages/a/lib/one.ts": "export function readThing(x: string): string { return x }\n",
			"packages/b/lib/two.ts": "export function readOther(x: string): string { return x }\n",
		})

		expect(await findAffixPairs(context)).toEqual([])
	})

	it("runs over the current tree and agrees with the check's own count", async () => {
		const context = await collectRepoContext()
		const pairs = await findAffixPairs(context)

		expect(await exportNameAffixCheck.run(context)).toHaveLength(pairs.length)
	})
})

describe("findDanglingLinks", () => {
	it("reports a link naming nothing the tree declares", async () => {
		const context = await plant({
			"packages/a/lib/reader.ts":
				"/**\n * @see {@linkcode readPackageJSONFile} for the manifest overload.\n */\nexport function readLocalJSONFile(path: string): string { return path }\n",
		})

		const dangling = await findDanglingLinks(context)

		expect(dangling).toEqual([{ file: "packages/a/lib/reader.ts", line: 2, target: "readPackageJSONFile" }])
	})

	it("accepts a link to a name declared in another package, and to a language built-in", async () => {
		const context = await plant({
			"packages/a/lib/home.ts": "export function readPackageJSON(path: string): string { return path }\n",
			"packages/b/lib/user.ts":
				"/**\n * {@link readPackageJSON} and {@link Object.entries} both resolve.\n */\nexport function use(): void {}\n",
		})

		expect(await findDanglingLinks(context)).toEqual([])
	})

	it("leaves a URL target alone", async () => {
		const context = await plant({
			"packages/a/lib/x.ts": "/**\n * {@link https://example.com/spec}\n */\nexport function use(): void {}\n",
		})

		expect(await findDanglingLinks(context)).toEqual([])
	})

	it("runs over the current tree and agrees with the check's own count", async () => {
		const context = await collectRepoContext()
		const dangling = await findDanglingLinks(context)

		expect(await docLinkTargetsCheck.run(context)).toHaveLength(dangling.length)
	})
})
