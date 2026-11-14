// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { git, GitClient } from "@mailwoman/core/git"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { fingerprintAdminInputs } from "#tools/pipeline/admin/inputs"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function commit(directory: PathBuilder, file: string, content: string): Promise<void> {
	const client = new GitClient({ cwd: directory })

	await writeLocalTextFile(content, directory(file))
	await client.read(["add", file])
	await client.read(["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", file])
}

/**
 * Two WOF-shaped clones and one GeoNames file.
 */
async function fixture(): Promise<{ root: PathBuilder; repos: PathBuilder; geonames: PathBuilder }> {
	const root = fixtures.use(await temporaryDirectory("admin-inputs-")).path

	for (const repo of ["whosonfirst-data-admin-ad", "whosonfirst-data-admin-us"]) {
		await new GitClient({ cwd: root }).read([
			"init",
			"--quiet",
			"--initial-branch=main",
			root("repos", repo).toString(),
		])

		await commit(root("repos", repo), "README", `${repo}\n`)
	}

	await writeLocalTextFile("1\tPlace\n", root("geonames", "AD.txt"))

	return { root, repos: root("repos"), geonames: root("geonames") }
}

describe("fingerprintAdminInputs", () => {
	it("gives the same fingerprints for the same inputs, and changes only the fingerprint whose input changed", async () => {
		const { root, repos, geonames } = await fixture()

		const read = () =>
			fingerprintAdminInputs({
				dataDir: repos,
				geonamesCountries: ["AD", "US"],
				geonamesDir: geonames,
				alternateDir: root("geonames-alternate"),
			})

		const first = await read()

		expect(await read()).toEqual(first)
		expect(first.wof).toMatch(/^sha256:[0-9a-f]{16} \(2 repos\)$/)
		expect(first.geonames).toMatch(/^sha256:[0-9a-f]{16} \(1 files\)$/)

		await commit(repos("whosonfirst-data-admin-us"), "CHANGE", "one new record\n")
		const afterCommit = await read()

		expect(afterCommit.wof).not.toBe(first.wof)
		expect(afterCommit.geonames).toBe(first.geonames)

		await writeLocalTextFile("1\tPlace\n2\tAnother place\n", geonames("AD.txt"))

		expect((await read()).geonames).not.toBe(afterCommit.geonames)
	})

	it("takes the newest commit date among the clones as the build's date", async () => {
		const { root, repos, geonames } = await fixture()

		const dates = await Promise.all(
			["whosonfirst-data-admin-ad", "whosonfirst-data-admin-us"].map(async (repo) =>
				Date.parse((await git(["log", "-1", "--format=%cI"], repos(repo))).trim())
			)
		)

		const { newestInputDate } = await fingerprintAdminInputs({
			dataDir: repos,
			geonamesCountries: ["AD"],
			geonamesDir: geonames,
			alternateDir: root("geonames-alternate"),
		})

		expect(Date.parse(newestInputDate)).toBe(Math.max(...dates))
	})
})
