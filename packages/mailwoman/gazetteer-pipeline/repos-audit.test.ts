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

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { auditReposRoot, CloneLayout, clonedCountries, parseRepoName, reposSentence } from "./repos-audit.ts"

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true })
	}
})

function reposRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mw-repos-audit-"))

	roots.push(root)

	return root
}

/**
 * A clone with one commit, so the audit has a vintage to read.
 */
function clone(dir: string, marker: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "README.md"), marker)
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir })
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir })
	execFileSync("git", ["add", "-A"], { cwd: dir })
	execFileSync("git", ["commit", "-qm", marker], { cwd: dir })
}

describe("auditReposRoot — layouts", () => {
	it("reads both the flat and the nested layout", () => {
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "flat")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-fr"), "nested")

		const audit = auditReposRoot(root)

		expect(audit.repos.map((r) => r.name).toSorted()).toEqual([
			"whosonfirst-data-admin-fr",
			"whosonfirst-data-admin-us",
		])

		expect(audit.repos.find((r) => r.name.endsWith("-us"))?.layouts).toEqual([CloneLayout.Flat])
		expect(audit.repos.find((r) => r.name.endsWith("-fr"))?.layouts).toEqual([CloneLayout.Nested])
	})

	it("reports a repo present in BOTH layouts as duplicated, not as two repos", () => {
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "same")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-us"), "same")

		const audit = auditReposRoot(root)

		expect(audit.repos).toHaveLength(1)
		expect(audit.duplicated).toHaveLength(1)
		expect(audit.duplicated[0]!.layouts.toSorted()).toEqual([CloneLayout.Flat, CloneLayout.Nested])
	})

	it("separates DIVERGED from merely duplicated", () => {
		const root = reposRoot()

		// Identical content, so identical commits: the measured lab state, where the cost is read time only.
		clone(join(root, "whosonfirst-data-admin-jp"), "same")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-jp"), "same")
		// Different content, so different commits: the state where the ingest's result depends on the order
		// FastGlob happens to enumerate in, because spr is INSERT OR REPLACE and the last write wins.
		clone(join(root, "whosonfirst-data-admin-kr"), "old")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-kr"), "new")

		const audit = auditReposRoot(root)

		expect(audit.duplicated.map((r) => r.name).toSorted()).toEqual([
			"whosonfirst-data-admin-jp",
			"whosonfirst-data-admin-kr",
		])

		expect(audit.diverged.map((r) => r.name)).toEqual(["whosonfirst-data-admin-kr"])
	})

	it("reports a missing root as empty rather than throwing", () => {
		// A caller auditing a machine that has never synced must get an answer, not an exception.
		const audit = auditReposRoot(join(reposRoot(), "nope"))

		expect(audit.repos).toEqual([])
		expect(audit.duplicated).toEqual([])
	})

	it("records no vintage for a directory that is not a checkout", () => {
		const root = reposRoot()

		mkdirSync(join(root, "whosonfirst-data-admin-de"), { recursive: true })

		const audit = auditReposRoot(root)

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
	it("reports what a build would actually ingest, whatever any list says", () => {
		// `ingestWOF` globs the root and reads no list, so a clone nobody declared still becomes coverage.
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-tr"), "x")
		clone(join(root, "whosonfirst-data-postalcode-tr"), "x")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-fr"), "x")

		expect(clonedCountries(auditReposRoot(root))).toEqual(["FR", "TR"])
	})
})

describe("reposSentence", () => {
	it("says the duplication costs disk when the copies agree", () => {
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "same")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-us"), "same")

		expect(reposSentence(auditReposRoot(root))).toContain("read time and disk")
	})

	it("says the result depends on enumeration order when they do not", () => {
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "old")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-us"), "new")

		expect(reposSentence(auditReposRoot(root))).toContain("enumeration order")
	})

	it("says none checked out twice rather than going quiet", () => {
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "x")

		expect(reposSentence(auditReposRoot(root))).toContain("none checked out twice")
	})
})

describe("auditReposRoot — an alias is not a duplicate", () => {
	it("reports a symlinked second path as ALIASED, not as a second checkout", () => {
		// The lab's nested `whosonfirst-data-admin-us` is a symlink to the flat one. Comparing `ls` output calls
		// that a duplicate and it is not — a directory cannot diverge from itself. It is still read twice,
		// because ingest-wof passes no followSymbolicLinks and fast-glob defaults it to true.
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "x")
		mkdirSync(join(root, "whosonfirst-data"), { recursive: true })
		symlinkSync(join(root, "whosonfirst-data-admin-us"), join(root, "whosonfirst-data", "whosonfirst-data-admin-us"))

		const audit = auditReposRoot(root)

		expect(audit.repos).toHaveLength(1)
		expect(audit.aliased.map((r) => r.name)).toEqual(["whosonfirst-data-admin-us"])
		expect(audit.duplicated).toEqual([])
		// An alias can never reach the state that makes a duplicate a correctness question.
		expect(audit.diverged).toEqual([])
	})

	it("traverses a symlinked entry at all — Dirent.isDirectory() is false for one", () => {
		// The bug this pins: a walk keyed on isDirectory() alone skipped the link entirely and reported the repo
		// as single-layout, describing a tree the ingest does not see.
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "x")
		mkdirSync(join(root, "whosonfirst-data"), { recursive: true })
		symlinkSync(join(root, "whosonfirst-data-admin-us"), join(root, "whosonfirst-data", "whosonfirst-data-admin-us"))

		expect(auditReposRoot(root).repos[0]!.layouts.toSorted()).toEqual([CloneLayout.Flat, CloneLayout.Nested])
	})

	it("ignores a broken link rather than counting it as a clone", () => {
		const root = reposRoot()

		mkdirSync(join(root, "whosonfirst-data"), { recursive: true })
		symlinkSync(join(root, "gone"), join(root, "whosonfirst-data", "whosonfirst-data-admin-zz"))

		expect(auditReposRoot(root).repos).toEqual([])
	})

	it("says both counts in the sentence, because they mean different things", () => {
		const root = reposRoot()

		clone(join(root, "whosonfirst-data-admin-us"), "x")
		mkdirSync(join(root, "whosonfirst-data"), { recursive: true })
		symlinkSync(join(root, "whosonfirst-data-admin-us"), join(root, "whosonfirst-data", "whosonfirst-data-admin-us"))
		clone(join(root, "whosonfirst-data-admin-jp"), "same")
		clone(join(root, "whosonfirst-data", "whosonfirst-data-admin-jp"), "same")

		const sentence = reposSentence(auditReposRoot(root))

		expect(sentence).toContain("1 checked out TWICE")
		expect(sentence).toContain("1 symlinked into the other layout")
	})
})
