/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { resolveWOFDataDir, resolveWOFRepo, wofRepoName } from "@mailwoman/core/resources/whosonfirst/extract-repo"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const REPO = "whosonfirst-data-postalcode-tr"

let root: TemporaryDirectory

beforeEach(async () => {
	root = await temporaryDirectory("mw-git-")
})

afterEach(() => root[Symbol.asyncDispose]())

describe("resolveWOFRepo", () => {
	it("finds a repository under its owner directory, where a sync writes it", async () => {
		const expected = root.path("whosonfirst-data", REPO)
		await makeDirectories(expected)

		expect(await resolveWOFRepo(root.path, REPO)).toBe(expected.toString())
	})

	it("finds a repository cloned flat at the root.path, the layout the postcode extracts were built from", async () => {
		const expected = root.path(REPO)
		await makeDirectories(expected)

		expect(await resolveWOFRepo(root.path, REPO)).toBe(expected.toString())
	})

	it("prefers the owner directory when a tree carries both", async () => {
		const owned = root.path("whosonfirst-data", REPO)
		await makeDirectories(owned)
		await makeDirectories(root.path(REPO))

		expect(await resolveWOFRepo(root.path, REPO)).toBe(owned.toString())
	})

	it("answers null when the repository is absent, so a caller can say which name is missing", async () => {
		expect(await resolveWOFRepo(root.path, REPO)).toBeNull()
	})
})

describe("wofRepoName", () => {
	it("lowercases the country, so an uppercase ISO code still names a real directory", () => {
		expect(wofRepoName("admin", "TR")).toBe("whosonfirst-data-admin-tr")
		expect(wofRepoName("postalcode", "tr")).toBe("whosonfirst-data-postalcode-tr")
	})
})

describe("resolveWOFDataDir", () => {
	it("answers the data directory readWOFFeature expects, in either layout", async () => {
		await makeDirectories(root.path("whosonfirst-data", REPO, "data"))

		expect(await resolveWOFDataDir(root.path, "postalcode", "TR")).toBe(
			root.path("whosonfirst-data", REPO, "data").toString()
		)
	})

	it("answers null for a country that is not cloned, so a caller can say which", async () => {
		expect(await resolveWOFDataDir(root.path, "admin", "zz")).toBeNull()
	})
})
