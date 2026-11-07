/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveWOFDataDir, resolveWOFRepo, wofClonePath, wofRepoName } from "#whosonfirst/extract-repo"

const REPO = "whosonfirst-data-postalcode-tr"

let root: TemporaryDirectory

beforeEach(async () => {
	root = await temporaryDirectory("mw-git-")
})

afterEach(() => root[Symbol.asyncDispose]())

describe("resolveWOFRepo", () => {
	it("finds a repository directly under the root, where a sync writes it", async () => {
		const expected = root.path(REPO)
		await makeDirectories(expected)

		await expect(resolveWOFRepo(root.path, REPO)).resolves.toBe(expected.toString())
		expect(wofClonePath(root.path, REPO)).toBe(expected.toString())
	})

	it("reads one path only, so a clone under an owner directory is reported as not cloned", async () => {
		await makeDirectories(root.path("whosonfirst-data", REPO))

		await expect(resolveWOFRepo(root.path, REPO)).resolves.toBeNull()
	})

	it("answers null when the repository is absent, so a caller can say which name is missing", async () => {
		await expect(resolveWOFRepo(root.path, REPO)).resolves.toBeNull()
	})
})

describe("wofRepoName", () => {
	it("lowercases the country, so an uppercase ISO code still names a real directory", () => {
		expect(wofRepoName("admin", "TR")).toBe("whosonfirst-data-admin-tr")
		expect(wofRepoName("postalcode", "tr")).toBe("whosonfirst-data-postalcode-tr")
	})
})

describe("resolveWOFDataDir", () => {
	it("answers the data directory readWOFFeature expects", async () => {
		await makeDirectories(root.path(REPO, "data"))

		await expect(resolveWOFDataDir(root.path, "postalcode", "TR")).resolves.toBe(root.path(REPO, "data").toString())
	})

	it("answers null for a country that is not cloned, so a caller can say which", async () => {
		await expect(resolveWOFDataDir(root.path, "admin", "zz")).resolves.toBeNull()
	})
})
