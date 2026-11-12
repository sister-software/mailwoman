// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A fold's own tier decides whether the candidate build takes its rows.
 *
 *   The fixture is the state the lab host's `postalcode-ni-osm.db` has no `layer_manifest`
 *   and records `tier = build-local` in a `meta` table.
 *   Without the opt-in, the build stops before opening the admin gazetteer.
 *   An absent admin database therefore proves the order.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, expect, test } from "vitest"

import { buildCandidate } from "#tools/pipeline"

let root: TemporaryDirectory
let ni: PathBuilder

beforeAll(async () => {
	root = await temporaryDirectory("candidate-folds-")
	ni = root.path("postalcode-ni-osm.db")

	using db = new DatabaseClient<WOFDatabase>(ni)

	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
	db.prepare("INSERT INTO meta VALUES ('license', 'Open Database License (ODbL) 1.0')").run()
	db.prepare("INSERT INTO meta VALUES ('tier', 'build-local')").run()
})

afterAll(() => root[Symbol.asyncDispose]())

test("buildCandidate refuses a build-local fold before building, and names it", async () => {
	const out = root.path("candidate.db")

	await expect(
		buildCandidate({
			adminDB: root.path("nope.db"),
			out,
			postcodeDatabases: [ni.toString()],
			localityDatabases: [],
			importanceDB: false,
		})
	).rejects.toThrow(/permits no publication/)

	await expect(
		buildCandidate({
			adminDB: root.path("nope.db"),
			out,
			postcodeDatabases: [ni.toString()],
			localityDatabases: [],
			importanceDB: false,
		})
	).rejects.toThrow(new RegExp(`${ni.toString()} \\(postalcode-ni-osm\\) tier build-local, recorded in meta`))

	// Refused before any output existed.
	await expect(pathExists(out)).resolves.toBe(false)
})

test("buildCandidate folds a build-local database when asked, and says so before the build", async () => {
	const phases: string[] = []

	// The build then fails on the absent admin gazetteer.
	// That failure differs from the refusal above.
	const candidate = await buildCandidate({
		adminDB: root.path("nope.db"),
		out: root.path("candidate-local.db"),
		postcodeDatabases: [ni.toString()],
		localityDatabases: [],
		importanceDB: false,
		includeBuildLocalFolds: true,
		onProgress: (phase, message) => phases.push(`${phase}: ${message}`),
	}).then(
		() => "built",
		(error: unknown) => (error as Error).message
	)

	expect(candidate).not.toMatch(/permits no publication/)

	expect(phases).toContainEqual(
		"fold-terms: folding 1 database(s) whose tier permits no publication, as asked: postalcode-ni-osm (build-local)"
	)
})

test("buildCandidate leaves the previous artifact in place when the build fails, and removes its temporary file", async () => {
	const out = root.path("candidate-previous.db")

	await writeLocalTextFile("previous", out)

	// The absent admin gazetteer fails the build inside buildCandidateTable, after the folds are admitted.
	await expect(
		buildCandidate({
			adminDB: root.path("nope.db"),
			out,
			postcodeDatabases: [ni.toString()],
			localityDatabases: [],
			importanceDB: false,
			includeBuildLocalFolds: true,
		})
	).rejects.toThrow(/unable to open database/)

	await expect(readLocalTextFile(out)).resolves.toBe("previous")
	await expect(pathExists(`${out}.tmp-${process.pid}`)).resolves.toBe(false)
})
