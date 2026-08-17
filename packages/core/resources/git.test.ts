/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveRepoDirectory } from "./git.ts"

const REPO = "whosonfirst-data-postalcode-tr"

let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "mw-git-"))
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe("resolveRepoDirectory", () => {
	it("finds a repository under its owner directory, where a sync writes it", async () => {
		const expected = join(root, "whosonfirst-data", REPO)
		await mkdir(expected, { recursive: true })

		expect(await resolveRepoDirectory(root, REPO)).toBe(expected)
	})

	it("finds a repository cloned flat at the root, the layout the postcode shards were built from", async () => {
		const expected = join(root, REPO)
		await mkdir(expected, { recursive: true })

		expect(await resolveRepoDirectory(root, REPO)).toBe(expected)
	})

	it("prefers the owner directory when a tree carries both", async () => {
		const owned = join(root, "whosonfirst-data", REPO)
		await mkdir(owned, { recursive: true })
		await mkdir(join(root, REPO), { recursive: true })

		expect(await resolveRepoDirectory(root, REPO)).toBe(owned)
	})

	it("answers null when the repository is absent, so a caller can say which name is missing", async () => {
		expect(await resolveRepoDirectory(root, REPO)).toBeNull()
	})
})
