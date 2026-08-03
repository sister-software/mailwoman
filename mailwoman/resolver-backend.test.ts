/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { join, resolve } from "node:path"

import { afterEach, expect, test, vi } from "vitest"

import {
	conventionCandidateDBPath,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "./resolver-backend.ts"

// This source file is a guaranteed-existing absolute path for the existsSync checks.
const THIS_FILE = import.meta.filename

function setEnv(key: string, value: string | undefined): void {
	vi.stubEnv(key, value as string)
}

afterEach(() => {
	vi.unstubAllEnvs()
})

test("wofShardPaths: builds the admin + postcode + tail + intl + NL-PC6 shard paths under a data root (#920/#977)", () => {
	expect(wofShardPaths("/data")).toEqual([
		"/data/wof/admin-global-priority.db",
		"/data/wof/postalcode-us.db",
		"/data/wof/postalcode-geonames-tail.db",
		"/data/wof/postalcode-intl.db",
		"/data/wof/postalcode-nl-pc6.db",
	])
})

test("mailwomanDataRoot: honors MAILWOMAN_DATA_ROOT, else the lab default; threads into wofShardPaths", () => {
	setEnv("MAILWOMAN_DATA_ROOT", "/custom/root")
	expect(mailwomanDataRoot()).toBe("/custom/root")
	expect(wofShardPaths()[0]).toBe("/custom/root/wof/admin-global-priority.db") // default arg uses the env

	setEnv("MAILWOMAN_DATA_ROOT", undefined)
	expect(mailwomanDataRoot()).toBe("/mnt/playpen/mailwoman-data")
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
	const root = resolve(import.meta.dirname, "test-fixtures", "candidate-root")

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
