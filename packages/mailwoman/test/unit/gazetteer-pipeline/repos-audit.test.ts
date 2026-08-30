/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The repos-root audit, against fixture trees.
 *
 *   The distinction under test is DUPLICATED versus DIVERGED. Both copies of a repo at the same commit
 *   cost read time and disk; two copies at different commits make the ingested value depend on FastGlob's
 *   enumeration order, because `spr` is written `INSERT OR REPLACE` and last writer wins. Reporting them
 *   as the same thing would either raise an alarm about wasted disk or bury a correctness hazard —
 *   and `verifyAdmin` cannot catch the second, since it tests floors.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { execFileSync } from "@mailwoman/platform/child_process"
import { join } from "@mailwoman/platform/path"
import {
	auditReposRoot,
	CloneLayout,
	clonedCountries,
	parseRepoName,
	reposSentence,
} from "mailwoman/gazetteer-pipeline/repos-audit"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function reposRoot(): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mw-repos-audit-")).path

	return root
}

/**
 * A clone with one commit, so the audit has a vintage to read.
 *
 * The commit DATES are pinned: a git commit hash covers author + committer timestamps, so two same-content clones only
 * hash identically when both commits land in the same wall-clock second. Fast local runs always did; a loaded CI runner
 * sometimes straddled the boundary, and the "duplicated" fixture read as DIVERGED — a flake that surfaced twice on
 * 2026-08-18 before the mechanism was pinned. With the dates fixed, identical content ⇒ identical hash, always.
 */
async function clone(dir: string, marker: string): Promise<void> {
	const env = childEnv({
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	})

	await makeDirectories(dir)
	await writeLocalFile(marker, join(dir, "README.md"))
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir })
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir })
	execFileSync("git", ["add", "-A"], { cwd: dir })
	execFileSync("git", ["commit", "-qm", marker], { cwd: dir, env })
}

describe("auditReposRoot — layouts", () => {
	it("reads both the flat and the nested layout", async () => {
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "flat")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-fr"), "nested")

		const audit = await auditReposRoot(await root)

		expect(audit.repos.map((r) => r.name).toSorted()).toEqual([
			"whosonfirst-data-admin-fr",
			"whosonfirst-data-admin-us",
		])

		expect(audit.repos.find((r) => r.name.endsWith("-us"))?.layouts).toEqual([CloneLayout.Flat])
		expect(audit.repos.find((r) => r.name.endsWith("-fr"))?.layouts).toEqual([CloneLayout.Nested])
	})

	it("reports a repo present in BOTH layouts as duplicated, not as two repos", async () => {
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "same")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-us"), "same")

		const audit = await auditReposRoot(await root)

		expect(audit.repos).toHaveLength(1)
		expect(audit.duplicated).toHaveLength(1)
		expect(audit.duplicated[0]!.layouts.toSorted()).toEqual([CloneLayout.Flat, CloneLayout.Nested])
	})

	it("separates DIVERGED from merely duplicated", async () => {
		const root = reposRoot()

		// Identical content, so identical commits: the measured lab state, where the cost is read time only.
		await clone(join(await root, "whosonfirst-data-admin-jp"), "same")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-jp"), "same")
		// Different content, so different commits: the state where the ingest's result depends on the order
		// FastGlob happens to enumerate in, because spr is INSERT OR REPLACE and the last write wins.
		await clone(join(await root, "whosonfirst-data-admin-kr"), "old")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-kr"), "new")

		const audit = await auditReposRoot(await root)

		expect(audit.duplicated.map((r) => r.name).toSorted()).toEqual([
			"whosonfirst-data-admin-jp",
			"whosonfirst-data-admin-kr",
		])

		expect(audit.diverged.map((r) => r.name)).toEqual(["whosonfirst-data-admin-kr"])
	})

	it("reports a missing root as empty rather than throwing", async () => {
		// A caller auditing a machine that has never synced must get an answer, not an exception.
		const audit = await auditReposRoot(join(await reposRoot(), "nope"))

		expect(audit.repos).toEqual([])
		expect(audit.duplicated).toEqual([])
	})

	it("records no vintage for a directory that is not a checkout", async () => {
		const root = reposRoot()

		await makeDirectories(join(await root, "whosonfirst-data-admin-de"))

		const audit = await auditReposRoot(await root)

		expect(audit.repos).toHaveLength(1)
		expect(audit.repos[0]!.commits).toEqual({})
	})
})

describe("parseRepoName", () => {
	it("splits theme and country", () => {
		expect(parseRepoName("whosonfirst-data-admin-us")).toEqual({ theme: "admin", country: "US" })
		expect(parseRepoName("whosonfirst-data-postalcode-gb")).toEqual({ theme: "postalcode", country: "GB" })
	})

	it("returns nothing for a repo that names no country", () => {
		// `whosonfirst-placetypes` is in the org and is not a country's data.
		expect(parseRepoName("whosonfirst-placetypes")).toEqual({})
	})
})

describe("clonedCountries — the directory IS the recipe", () => {
	it("reports what a build would actually ingest, whatever any list says", async () => {
		// `ingestWOF` globs the root and reads no list, so a clone nobody declared still becomes coverage.
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-tr"), "x")
		await clone(join(await root, "whosonfirst-data-postalcode-tr"), "x")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-fr"), "x")

		expect(clonedCountries(await auditReposRoot(await root))).toEqual(["FR", "TR"])
	})
})

describe("reposSentence", () => {
	it("says the duplication costs disk when the copies agree", async () => {
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "same")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-us"), "same")

		expect(reposSentence(await auditReposRoot(await root))).toContain("read time and disk")
	})

	it("says the result depends on enumeration order when they do not", async () => {
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "old")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-us"), "new")

		expect(reposSentence(await auditReposRoot(await root))).toContain("enumeration order")
	})

	it("says none checked out twice rather than going quiet", async () => {
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "x")

		expect(reposSentence(await auditReposRoot(await root))).toContain("none checked out twice")
	})
})

describe("auditReposRoot — an alias is not a duplicate", () => {
	it("reports a symlinked second path as ALIASED, not as a second checkout", async () => {
		// The lab's nested `whosonfirst-data-admin-us` is a symlink to the flat one. Comparing `ls` output calls
		// that a duplicate and it is not — a directory cannot diverge from itself. It is still read twice,
		// because ingest-wof passes no followSymbolicLinks and fast-glob defaults it to true.
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "x")
		await makeDirectories(join(await root, "whosonfirst-data"))

		await createSymbolicLink(
			join(await root, "whosonfirst-data-admin-us"),
			join(await root, "whosonfirst-data", "whosonfirst-data-admin-us")
		)

		const audit = await auditReposRoot(await root)

		expect(audit.repos).toHaveLength(1)
		expect(audit.aliased.map((r) => r.name)).toEqual(["whosonfirst-data-admin-us"])
		expect(audit.duplicated).toEqual([])
		// An alias can never reach the state that makes a duplicate a correctness question.
		expect(audit.diverged).toEqual([])
	})

	it("traverses a symlinked entry at all — Dirent.isDirectory() is false for one", async () => {
		// The bug this pins: a walk keyed on isDirectory() alone skipped the link entirely and reported the repo
		// as single-layout, describing a tree the ingest does not see.
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "x")
		await makeDirectories(join(await root, "whosonfirst-data"))

		await createSymbolicLink(
			join(await root, "whosonfirst-data-admin-us"),
			join(await root, "whosonfirst-data", "whosonfirst-data-admin-us")
		)

		expect((await auditReposRoot(await root)).repos[0]!.layouts.toSorted()).toEqual([
			CloneLayout.Flat,
			CloneLayout.Nested,
		])
	})

	it("ignores a broken link rather than counting it as a clone", async () => {
		const root = reposRoot()

		await makeDirectories(join(await root, "whosonfirst-data"))

		await createSymbolicLink(
			join(await root, "gone"),
			join(await root, "whosonfirst-data", "whosonfirst-data-admin-zz")
		)

		expect((await auditReposRoot(await root)).repos).toEqual([])
	})

	it("says both counts in the sentence, because they mean different things", async () => {
		const root = reposRoot()

		await clone(join(await root, "whosonfirst-data-admin-us"), "x")
		await makeDirectories(join(await root, "whosonfirst-data"))

		await createSymbolicLink(
			join(await root, "whosonfirst-data-admin-us"),
			join(await root, "whosonfirst-data", "whosonfirst-data-admin-us")
		)

		await clone(join(await root, "whosonfirst-data-admin-jp"), "same")
		await clone(join(await root, "whosonfirst-data", "whosonfirst-data-admin-jp"), "same")

		const sentence = reposSentence(await auditReposRoot(await root))

		expect(sentence).toContain("1 checked out TWICE")
		expect(sentence).toContain("1 symlinked into the other layout")
	})
})
