/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolveWOFDataDir, resolveWOFRepo, wofRepoName } from "@mailwoman/core/resources/whosonfirst/sharded-repo"
import { mkdtemp, mkdir, rm } from "@mailwoman/platform/fs/promises"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const REPO = "whosonfirst-data-postalcode-tr"

let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "mw-git-"))
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe("resolveWOFRepo", () => {
	it("finds a repository under its owner directory, where a sync writes it", async () => {
		const expected = join(root, "whosonfirst-data", REPO)
		await mkdir(expected, { recursive: true })

		expect(resolveWOFRepo(root, REPO)).toBe(expected)
	})

	it("finds a repository cloned flat at the root, the layout the postcode shards were built from", async () => {
		const expected = join(root, REPO)
		await mkdir(expected, { recursive: true })

		expect(resolveWOFRepo(root, REPO)).toBe(expected)
	})

	it("prefers the owner directory when a tree carries both", async () => {
		const owned = join(root, "whosonfirst-data", REPO)
		await mkdir(owned, { recursive: true })
		await mkdir(join(root, REPO), { recursive: true })

		expect(resolveWOFRepo(root, REPO)).toBe(owned)
	})

	it("answers null when the repository is absent, so a caller can say which name is missing", async () => {
		expect(resolveWOFRepo(root, REPO)).toBeNull()
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
		await mkdir(join(root, "whosonfirst-data", REPO, "data"), { recursive: true })

		expect(resolveWOFDataDir(root, "postalcode", "TR")).toBe(join(root, "whosonfirst-data", REPO, "data"))
	})

	it("answers null for a country that is not cloned, so a caller can say which", async () => {
		expect(resolveWOFDataDir(root, "admin", "zz")).toBeNull()
	})
})
