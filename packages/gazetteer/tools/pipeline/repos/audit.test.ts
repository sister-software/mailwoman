/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The repos-root audit, against fixture trees.
 *
 *   Every clone sits at `<root>/<name>`. The audit's other job is reporting each directory that's not a clone,
 *   because the admin ingest globs the whole root and reads a stray's GeoJSON as well.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { gitSync } from "@mailwoman/core/git"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import {
	auditReposRoot,
	clonedCountries,
	isRepositoryDirectory,
	parseRepoName,
	reposSentence,
} from "#tools/pipeline/repos/audit"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function reposRoot(): Promise<PathBuilder> {
	return fixtures.use(await temporaryDirectory("mw-repos-audit-")).path
}

/**
 * A clone with one commit, so the audit has a vintage to read.
 */
async function clone(dir: PathBuilder): Promise<void> {
	await makeDirectories(dir)
	await writeLocalFile("x", dir("README.md"))

	gitSync(["init", "-q", "-b", "main"], { cwd: dir })
	gitSync(["add", "-A"], { cwd: dir })
	gitSync(["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "x"], { cwd: dir })
}

describe("auditReposRoot", () => {
	it("reads every clone directly under the root, the placetypes repository included", async () => {
		const root = await reposRoot()

		await clone(root("whosonfirst-data-admin-us"))
		await clone(root("whosonfirst-data-postalcode-us"))
		await clone(root("whosonfirst-placetypes"))

		const audit = await auditReposRoot(root)

		expect(audit.repos.map((r) => r.name)).toEqual([
			"whosonfirst-data-admin-us",
			"whosonfirst-data-postalcode-us",
			"whosonfirst-placetypes",
		])

		expect(audit.repos.every((r) => typeof r.commit === "string")).toBe(true)
		expect(audit.strays).toEqual([])
	})

	it("reports an owner directory holding a second layout as a stray, and leaves its contents out of the repos", async () => {
		const root = await reposRoot()

		await clone(root("whosonfirst-data-admin-us"))
		await clone(root("whosonfirst-data", "whosonfirst-data-admin-fr"))

		const audit = await auditReposRoot(root)

		expect(audit.repos.map((r) => r.name)).toEqual(["whosonfirst-data-admin-us"])
		expect(audit.strays).toEqual(["whosonfirst-data"])
	})

	it("reports a missing root as empty rather than throwing", async () => {
		const root = await reposRoot()

		const audit = await auditReposRoot(root("nope"))

		expect(audit).toMatchObject({ repos: [], strays: [], links: [] })
	})

	it("reports a symbolic link, including one that points at itself, instead of throwing", async () => {
		const root = await reposRoot()

		await clone(root("whosonfirst-data-admin-us"))
		await createSymbolicLink(root("whosonfirst-data-admin-us"), root("whosonfirst-data-admin-us-alias"))
		await createSymbolicLink(root("whosonfirst-data-admin-gb"), root("whosonfirst-data-admin-gb"))

		const audit = await auditReposRoot(root)

		expect(audit.repos.map((r) => r.name)).toEqual(["whosonfirst-data-admin-us"])
		expect(audit.links).toEqual(["whosonfirst-data-admin-gb", "whosonfirst-data-admin-us-alias"])
		expect(reposSentence(audit)).toContain("2 symbolic links")
	})

	it("records no vintage for a directory that is not a checkout", async () => {
		const root = await reposRoot()

		await makeDirectories(root("whosonfirst-data-admin-de"))

		const audit = await auditReposRoot(root)

		expect(audit.repos).toEqual([{ name: "whosonfirst-data-admin-de", commit: null, theme: "admin", country: "DE" }])
	})
})

describe("isRepositoryDirectory", () => {
	it("accepts country repositories and the placetypes repository and refuses an owner directory", () => {
		expect(isRepositoryDirectory("whosonfirst-data-admin-us")).toBe(true)
		expect(isRepositoryDirectory("whosonfirst-data-admin-alt")).toBe(true)
		expect(isRepositoryDirectory("whosonfirst-placetypes")).toBe(true)
		expect(isRepositoryDirectory("whosonfirst-data")).toBe(false)
		expect(isRepositoryDirectory("whosonfirst")).toBe(false)
	})
})

describe("parseRepoName", () => {
	it("splits theme and country", () => {
		expect(parseRepoName("whosonfirst-data-admin-us")).toEqual({ theme: "admin", country: "US" })
		expect(parseRepoName("whosonfirst-data-postalcode-gb")).toEqual({ theme: "postalcode", country: "GB" })
	})

	it("returns nothing for a repo that names no country", () => {
		expect(parseRepoName("whosonfirst-placetypes")).toEqual({})
	})
})

describe("clonedCountries — the directory is the recipe", () => {
	it("reports what a build would ingest, whatever any list says", async () => {
		// `ingestWOF` globs the root and reads no list, so an undeclared clone still becomes coverage.
		const root = await reposRoot()

		await clone(root("whosonfirst-data-admin-tr"))
		await clone(root("whosonfirst-data-postalcode-tr"))
		await clone(root("whosonfirst-data-admin-fr"))

		expect(clonedCountries(await auditReposRoot(root))).toEqual(["FR", "TR"])
	})
})

describe("reposSentence", () => {
	it("lists the strays by name", async () => {
		const root = await reposRoot()

		await clone(root("whosonfirst-data-admin-us"))
		await makeDirectories(root("whosonfirst-data"))

		const sentence = reposSentence(await auditReposRoot(root))

		expect(sentence).toContain("1 other directory under the root (whosonfirst-data)")
		expect(sentence).toContain("the admin ingest also reads")
	})

	it("states that every directory is a clone when there are no strays", async () => {
		const root = await reposRoot()

		await clone(root("whosonfirst-data-admin-us"))

		expect(reposSentence(await auditReposRoot(root))).toContain("every directory under the root is a repository clone")
	})
})
