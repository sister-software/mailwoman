/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolveWOFDataDir, resolveWOFRepo, wofRepoName } from "@mailwoman/core/resources/whosonfirst/sharded-repo"
import { mkdir } from "@mailwoman/platform/fs/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { temporaryDirectory, type TemporaryDirectory } from "#fs/temporary"

const REPO = "whosonfirst-data-postalcode-tr"

let root: TemporaryDirectory

beforeEach(async () => {
	root = await temporaryDirectory("mw-git-")
})

afterEach(() => root[Symbol.asyncDispose]())

describe("resolveWOFRepo", () => {
	it("finds a repository under its owner directory, where a sync writes it", async () => {
		const expected = root.resolve("whosonfirst-data", REPO)
		await mkdir(expected, { recursive: true })

		expect(await resolveWOFRepo(root.path, REPO)).toBe(expected)
	})

	it("finds a repository cloned flat at the root.path, the layout the postcode shards were built from", async () => {
		const expected = root.resolve(REPO)
		await mkdir(expected, { recursive: true })

		expect(await resolveWOFRepo(root.path, REPO)).toBe(expected)
	})

	it("prefers the owner directory when a tree carries both", async () => {
		const owned = root.resolve("whosonfirst-data", REPO)
		await mkdir(owned, { recursive: true })
		await mkdir(root.resolve(REPO), { recursive: true })

		expect(await resolveWOFRepo(root.path, REPO)).toBe(owned)
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
		await mkdir(root.resolve("whosonfirst-data", REPO, "data"), { recursive: true })

		expect(await resolveWOFDataDir(root.path, "postalcode", "TR")).toBe(root.resolve("whosonfirst-data", REPO, "data"))
	})

	it("answers null for a country that is not cloned, so a caller can say which", async () => {
		expect(await resolveWOFDataDir(root.path, "admin", "zz")).toBeNull()
	})
})
