/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { conventionCandidateDBPath, resolveCandidateDBPath } from "mailwoman/resolver-backend"
import { afterEach, expect, test, vi } from "vitest"

// This source file is a guaranteed-existing absolute path for the existsSync checks.
const THIS_FILE = import.meta.filename

function setEnv(key: string, value: string | undefined): void {
	vi.stubEnv(key, value as string)
}

afterEach(() => {
	vi.unstubAllEnvs()
})

test("resolveCandidateDBPath: returns an explicit/env path only when it exists on disk", async () => {
	// A data root with no candidate.db under it, so the convention fallback stays out of the way.
	setEnv("MAILWOMAN_DATA_ROOT", "/no/such/root")
	setEnv("MAILWOMAN_CANDIDATE_DB", undefined)
	expect(await resolveCandidateDBPath()).toBeUndefined() // no env var set and no file at the convention path
	expect(await resolveCandidateDBPath("/no/such/candidate.db")).toBeUndefined() // explicit but missing
	expect(await resolveCandidateDBPath(THIS_FILE)).toBe(THIS_FILE) // explicit + exists

	setEnv("MAILWOMAN_CANDIDATE_DB", THIS_FILE)
	expect(await resolveCandidateDBPath()).toBe(THIS_FILE) // from env + exists
	setEnv("MAILWOMAN_CANDIDATE_DB", "/no/such/candidate.db")
	expect(await resolveCandidateDBPath()).toBeUndefined() // env path missing
})

test("resolveCandidateDBPath: falls back to the convention path under the data root, and 'none' pins the FTS backend", async () => {
	// The fallback is what makes the candidate table the default backend, so the path
	// it reaches has to be the one `data pull candidate` writes.
	// This asserted `<root>/wof/candidate.db` while the 2026-09-15 regrouping moved
	// the artifact to `<root>/db/wof/`, and the fixture carried the old layout too —
	// so the pair agreed with each other and with no data root on disk.
	// `resolveCandidateDBPath()` answered undefined on a host holding the file,
	// and the resolver fell back to FTS without saying so.
	const root = resolvePackagePath("mailwoman", "lib", "test-fixtures", "candidate-root")
	const conventionPath = wofDatabaseRoot(root)("candidate.db").toString()

	setEnv("MAILWOMAN_DATA_ROOT", root)
	setEnv("MAILWOMAN_CANDIDATE_DB", undefined)
	expect(conventionCandidateDBPath()).toBe(conventionPath)
	expect(await resolveCandidateDBPath()).toBe(conventionPath)

	// An explicit path still outranks the convention.
	expect(await resolveCandidateDBPath(THIS_FILE)).toBe(THIS_FILE)

	// `none` is the opt-out, and it has to beat the convention path.
	// Otherwise there is no way back to the FTS backend on a machine that has pulled the gazetteer.
	expect(await resolveCandidateDBPath("none")).toBeUndefined()
	setEnv("MAILWOMAN_CANDIDATE_DB", "none")
	expect(await resolveCandidateDBPath()).toBeUndefined()
})

test("resolveCandidateDBPath: an explicit data root does not depend on MAILWOMAN_DATA_ROOT", async () => {
	const root = resolvePackagePath("mailwoman", "lib", "test-fixtures", "candidate-root")

	setEnv("MAILWOMAN_DATA_ROOT", "/no/such/root")
	setEnv("MAILWOMAN_CANDIDATE_DB", undefined)

	expect(await resolveCandidateDBPath(undefined, root)).toBe(wofDatabaseRoot(root)("candidate.db").toString())
})

test("loadCapitalIndex prefers the artifact's capital table, falls back to the repo file, and throws with neither (#1880)", async () => {
	const { DatabaseClient } = await import("@mailwoman/sqlite/client")
	const { createCapitalTable } = await import("@mailwoman/resolver-wof-sqlite/capital-schema")
	const { loadCapitalIndex } = await import("mailwoman/resolver-backend")

	await using dirDirectory = await temporaryDirectory("mw-capital-loader-")
	const dir = dirDirectory.path

	// An artifact carrying the table: the CR capital only.
	const artifactPath = dir("candidate.db")
	using artifact = new DatabaseClient<CandidateDatabase>(artifactPath)

	await createCapitalTable<CandidateDatabase>(artifact)

	artifact
		.prepare("INSERT INTO capital (country, latitude, longitude, level, keys) VALUES (?, ?, ?, ?, ?)")
		.run("CR", 9.9333, -84.0833, "national", stringifyJSON(["san jose"]))

	// A repo-style file carrying a different entry (GD), so which source served is observable.
	const repoPath = dir("capitals-v1.json")

	await writeLocalJSONFile(
		{
			version: 1,
			entries: [{ country: "GD", latitude: 12.0529, longitude: -61.7523, level: "national", k: ["st georges"] }],
		},
		repoPath
	)

	// Artifact wins when present.
	const fromArtifact = await loadCapitalIndex({ candidateDB: artifactPath, path: repoPath })

	expect(fromArtifact!.levelOfPlace("San José", "CR", 9.93, -84.08)).toBe(2)
	expect(fromArtifact!.levelOfPlace("St. Georges", "GD", 12.05, -61.75)).toBe(0)

	// An artifact without the table falls through to the repo file.
	const barePath = dir("bare.db")

	new DatabaseClient<CandidateDatabase>(barePath).destroy()
	const fromRepo = await loadCapitalIndex({ candidateDB: barePath, path: repoPath })

	expect(fromRepo!.levelOfPlace("St. Georges", "GD", 12.05, -61.75)).toBe(2)

	// Neither source: the explicitly-asked-for key must fail loudly rather than no-op.
	await expect(loadCapitalIndex({ candidateDB: barePath, path: dir("missing.json") })).rejects.toThrow(/capital_tier/)

	// The default-on path degrades on the same absence instead of failing session construction.
	expect(
		await loadCapitalIndex({ candidateDB: barePath, path: dir("missing.json"), missing: "degrade" })
	).toBeUndefined()

	// A reference that exists but is malformed throws under both modes — corruption is a defect, never an absence.
	const corruptPath = dir("corrupt.json")

	await writeLocalJSONFile({ version: 99, entries: [] }, corruptPath)
	await expect(loadCapitalIndex({ candidateDB: barePath, path: corruptPath, missing: "degrade" })).rejects.toThrow(/v1/)
})
