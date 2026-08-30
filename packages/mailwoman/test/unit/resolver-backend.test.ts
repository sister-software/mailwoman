/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DefaultMailwomanPaths } from "@mailwoman/core/env"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { join, resolve } from "@mailwoman/platform/path"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import {
	conventionCandidateDBPath,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"
import { afterEach, expect, test, vi } from "vitest"

// This source file is a guaranteed-existing absolute path for the existsSync checks.
const THIS_FILE = import.meta.filename

function setEnv(key: string, value: string | undefined): void {
	vi.stubEnv(key, value as string)
}

afterEach(() => {
	vi.unstubAllEnvs()
})

test("wofShardPaths: builds the admin + postcode + tail + intl + NL-PC6 + NI-OSM shard paths under a data root (#920/#977)", () => {
	expect(wofShardPaths("/data")).toEqual([
		"/data/wof/admin-global-priority.db",
		"/data/wof/postalcode-us.db",
		"/data/wof/postalcode-geonames-tail.db",
		"/data/wof/postalcode-intl.db",
		"/data/wof/postalcode-nl-pc6.db",
		// Build-local (ODbL): present only on the machine that built it, which is exactly why it can be
		// listed unconditionally — every caller filters with `existsSync`, and that filter IS the tier.
		"/data/wof/postalcode-ni-osm.db",
	])
})

test("mailwomanDataRoot: honors MAILWOMAN_DATA_ROOT and threads it into wofShardPaths", () => {
	setEnv("MAILWOMAN_DATA_ROOT", "/custom/root")
	expect(mailwomanDataRoot()).toBe("/custom/root")
	expect(wofShardPaths()[0]).toBe("/custom/root/wof/admin-global-priority.db") // default arg uses the env

	setEnv("MAILWOMAN_DATA_ROOT", DefaultMailwomanPaths.data)
	expect(mailwomanDataRoot()).toBe(DefaultMailwomanPaths.data)
})

test("resolveCandidateDBPath: returns an explicit/env path only when it exists on disk", () => {
	// A data root with no candidate.db under it, so the convention fallback stays out of the way.
	setEnv("MAILWOMAN_DATA_ROOT", "/no/such/root")
	setEnv("MAILWOMAN_CANDIDATE_DB", undefined)
	expect(resolveCandidateDBPath()).toBeUndefined() // nothing set, nothing at the convention path
	expect(resolveCandidateDBPath("/no/such/candidate.db")).toBeUndefined() // explicit but missing
	expect(resolveCandidateDBPath(THIS_FILE)).toBe(THIS_FILE) // explicit + exists

	setEnv("MAILWOMAN_CANDIDATE_DB", THIS_FILE)
	expect(resolveCandidateDBPath()).toBe(THIS_FILE) // from env + exists
	setEnv("MAILWOMAN_CANDIDATE_DB", "/no/such/candidate.db")
	expect(resolveCandidateDBPath()).toBeUndefined() // env path missing
})

test("resolveCandidateDBPath: falls back to <data-root>/wof/candidate.db, and 'none' pins the FTS backend", () => {
	// The fallback is what makes the candidate table the default backend. Pointed at this file's own
	// directory tree so the convention path is a real file: `<root>/wof/candidate.db`.
	const root = resolve(import.meta.dirname, "../../test-fixtures/candidate-root")

	setEnv("MAILWOMAN_DATA_ROOT", root)
	setEnv("MAILWOMAN_CANDIDATE_DB", undefined)
	expect(conventionCandidateDBPath()).toBe(join(root, "wof", "candidate.db"))
	expect(resolveCandidateDBPath()).toBe(join(root, "wof", "candidate.db"))

	// An explicit path still outranks the convention.
	expect(resolveCandidateDBPath(THIS_FILE)).toBe(THIS_FILE)

	// `none` is the opt-out, and it has to beat the convention path — otherwise there is no way back
	// to the FTS backend on a machine that has pulled the gazetteer.
	expect(resolveCandidateDBPath("none")).toBeUndefined()
	setEnv("MAILWOMAN_CANDIDATE_DB", "none")
	expect(resolveCandidateDBPath()).toBeUndefined()
})

test("resolveCandidateDBPath: an explicit data root does not depend on MAILWOMAN_DATA_ROOT", () => {
	const root = resolve(import.meta.dirname, "../../test-fixtures/candidate-root")

	setEnv("MAILWOMAN_DATA_ROOT", "/no/such/root")
	setEnv("MAILWOMAN_CANDIDATE_DB", undefined)

	expect(resolveCandidateDBPath(undefined, root)).toBe(join(root, "wof", "candidate.db"))
})

test("loadCapitalIndex prefers the artifact's capital table, falls back to the repo file, and throws with neither (#1880)", async () => {
	const { DatabaseClient } = await import("@mailwoman/sqlite/client")
	const { createCapitalTable } = await import("@mailwoman/resolver-wof-sqlite/capital-schema")
	const { loadCapitalIndex } = await import("mailwoman/resolver-backend")

	await using dirDirectory = await temporaryDirectory("mw-capital-loader-")
	const dir = dirDirectory.path

	// An artifact carrying the table: the CR capital only.
	const artifactPath = join(dir, "candidate.db")
	using artifact = new DatabaseClient<CandidateDatabase>(artifactPath)

	await createCapitalTable<CandidateDatabase>(artifact)

	artifact
		.prepare("INSERT INTO capital (country, latitude, longitude, level, keys) VALUES (?, ?, ?, ?, ?)")
		.run("CR", 9.9333, -84.0833, "national", JSON.stringify(["san jose"]))

	// A repo-style file carrying a DIFFERENT entry (GD), so which source served is observable.
	const repoPath = join(dir, "capitals-v1.json")

	await writeLocalJSONFile(
		{
			version: 1,
			entries: [{ country: "GD", latitude: 12.0529, longitude: -61.7523, level: "national", k: ["st georges"] }],
		},
		repoPath
	)

	// Artifact wins when present.
	const fromArtifact = loadCapitalIndex({ candidateDB: artifactPath, path: repoPath })

	expect(fromArtifact!.levelOfPlace("San José", "CR", 9.93, -84.08)).toBe(2)
	expect(fromArtifact!.levelOfPlace("St. Georges", "GD", 12.05, -61.75)).toBe(0)

	// An artifact WITHOUT the table falls through to the repo file.
	const barePath = join(dir, "bare.db")

	new DatabaseClient<CandidateDatabase>(barePath).destroy()
	const fromRepo = loadCapitalIndex({ candidateDB: barePath, path: repoPath })

	expect(fromRepo!.levelOfPlace("St. Georges", "GD", 12.05, -61.75)).toBe(2)

	// Neither source: the explicitly-asked-for key must fail loudly, not no-op.
	expect(() => loadCapitalIndex({ candidateDB: barePath, path: join(dir, "missing.json") })).toThrow(/capital_tier/)

	// The DEFAULT-ON path degrades on the same absence instead of failing session construction.
	expect(
		loadCapitalIndex({ candidateDB: barePath, path: join(dir, "missing.json"), missing: "degrade" })
	).toBeUndefined()

	// A reference that EXISTS but is malformed throws under BOTH modes — corruption is a defect, never an absence.
	const corruptPath = join(dir, "corrupt.json")

	await writeLocalJSONFile({ version: 99, entries: [] }, corruptPath)
	expect(() => loadCapitalIndex({ candidateDB: barePath, path: corruptPath, missing: "degrade" })).toThrow(/v1/)
})
