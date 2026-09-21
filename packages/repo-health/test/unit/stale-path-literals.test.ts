/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The stale-path finder over a planted repository with a real rename in its history.
 *
 *   The check turns on the difference between a path that moved and a path that never existed, and that difference
 *   lives in git history — so the fixture is a real repository: commit two files, rename one, commit again. A
 *   planted directory with no history cannot exercise the test that makes the check usable.
 */

import { realPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
import {
	findStalePathLiterals,
	isRepositoryPathLiteral,
	stalePathLiteralsCheck,
} from "@mailwoman/repo-health/checks/stale-path-literals"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const git = (repoRoot: string, args: string[]) =>
	runFile("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], {
		cwd: repoRoot,
		encoding: "utf8",
	})

/**
 * A repository where `packages/thing/lib/old-name.ts` was renamed to `new-name.ts`,
 * plus whatever sources the caller plants afterwards.
 */
async function plant(sources: Record<string, string>) {
	const repoRoot = await realPath(fixtures.use(await temporaryDirectory("stale-paths-")).path)

	await writeLocalTextFile("export const thing = 1\n", resolvePath(repoRoot, "packages/thing/lib/old-name.ts"))
	await git(String(repoRoot), ["init", "--quiet"])
	await git(String(repoRoot), ["add", "-A"])
	await git(String(repoRoot), ["commit", "--quiet", "-m", "first"])
	await git(String(repoRoot), ["mv", "packages/thing/lib/old-name.ts", "packages/thing/lib/new-name.ts"])
	await git(String(repoRoot), ["commit", "--quiet", "-m", "rename"])

	for (const [file, text] of Object.entries(sources)) {
		await makeDirectories(join(String(repoRoot), file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(repoRoot, file))
	}

	return {
		repoRoot: String(repoRoot),
		trackedFiles: ["packages/thing/lib/new-name.ts", ...Object.keys(sources)],
	}
}

describe("isRepositoryPathLiteral", () => {
	it("admits a repository path with a file extension", () => {
		expect(isRepositoryPathLiteral("packages/core/lib/git.ts")).toBe(true)
		expect(isRepositoryPathLiteral("docs/engineering/SCOPE.mdx")).toBe(true)
		expect(isRepositoryPathLiteral("data/gazetteer/anchor-lexicon-v1.json")).toBe(true)
	})

	it("refuses a package specifier, which is a subpath export and not a directory", () => {
		expect(isRepositoryPathLiteral("mailwoman/gazetteer-pipeline")).toBe(false)
		expect(isRepositoryPathLiteral("@mailwoman/core/git")).toBe(false)
	})

	it("refuses a directory, a glob, an interpolation and a URL", () => {
		expect(isRepositoryPathLiteral("packages/core/lib")).toBe(false)
		expect(isRepositoryPathLiteral("packages/*/lib/index.ts")).toBe(false)
		expect(isRepositoryPathLiteral("packages/${name}/lib/index.ts")).toBe(false)
		expect(isRepositoryPathLiteral("https://example.invalid/packages/a/lib/x.ts")).toBe(false)
	})

	it("refuses derived output and a dated record", () => {
		expect(isRepositoryPathLiteral("packages/core/out/git.js")).toBe(false)
		expect(isRepositoryPathLiteral("packages/core/node_modules/x/index.ts")).toBe(false)
		expect(isRepositoryPathLiteral("packages/core/lib/x.tsbuildinfo")).toBe(false)
		expect(isRepositoryPathLiteral("docs/records/evals/2026-08-16-something.md")).toBe(false)
	})

	it("refuses prose that happens to name a directory", () => {
		expect(isRepositoryPathLiteral("see packages/core/lib/git.ts for the reader")).toBe(false)
	})
})

describe("findStalePathLiterals", () => {
	it("reports a literal naming the file that moved", async () => {
		const context = await plant({
			"packages/thing/lib/reader.ts": [
				"/**",
				" * Reads packages/thing/lib/old-name.ts.",
				" */",
				'export const SOURCE = "packages/thing/lib/old-name.ts"',
				"",
			].join("\n"),
		})

		const stale = await findStalePathLiterals(context)

		expect(stale).toEqual([
			{ file: "packages/thing/lib/reader.ts", line: 4, literal: "packages/thing/lib/old-name.ts" },
		])

		const diagnostics = await stalePathLiteralsCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]!.message).toContain("was tracked once and is gone")
	})

	it("says nothing about a literal naming the file's new home", async () => {
		const context = await plant({
			"packages/thing/lib/reader.ts": 'export const SOURCE = "packages/thing/lib/new-name.ts"\n',
		})

		expect(await findStalePathLiterals(context)).toEqual([])
	})

	it("says nothing about a path that never existed, which is a write target or a fixture", async () => {
		const context = await plant({
			"packages/thing/lib/reader.ts": [
				// Written by this module when it runs, so it is absent until then.
				'export const OUTPUT = "data/eval/calibration/confidences.jsonl"',
				// Planted by a test elsewhere. it names no real file and never did.
				'export const INVENTED = "packages/foo/new.ts"',
				"",
			].join("\n"),
		})

		expect(await findStalePathLiterals(context)).toEqual([])
	})

	it("leaves test sources alone, because a test plants trees", async () => {
		const context = await plant({
			"packages/thing/test/unit/reader.test.ts": 'const moved = "packages/thing/lib/old-name.ts"\n',
		})

		expect(await findStalePathLiterals(context)).toEqual([])
	})
})
