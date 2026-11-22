// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A small repository written to a temporary directory, for a test that plants a violation and runs a check on it.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { dirname } from "path-ts"

import type { RepoContext } from "#repo-health/check"

/**
 * The files of a fixture repository, keyed by repository-relative path.
 *
 * A string is written as given, and any other value is written as JSON.
 */
export type FixtureFiles = Readonly<Record<string, string | object>>

/**
 * A check's context over a fixture repository.
 *
 * Disposal removes the repository's directory.
 */
export interface FixtureRepository extends RepoContext, AsyncDisposable {}

/**
 * Writes `files` under a new temporary directory and returns the context a check runs on.
 *
 * Every written file is listed as tracked, in the order `files` gives them.
 * Take the result with `await using`, so the directory is removed when the test ends.
 */
export async function plantFixtureRepository(files: FixtureFiles): Promise<FixtureRepository> {
	const directory = await temporaryDirectory("repo-health-fixture-")

	for (const [file, content] of Object.entries(files)) {
		const path = directory.path(file)

		await makeDirectories(dirname(path))
		await writeLocalTextFile(typeof content === "string" ? content : prettyJSON(content), path)
	}

	return {
		repoRoot: directory.path.toString(),
		trackedFiles: Object.keys(files),
		[Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
	}
}
