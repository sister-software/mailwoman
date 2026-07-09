/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { afterEach, expect, test, vi } from "vitest"

import { mailwomanDataRoot, resolveCandidateDBPath, wofShardPaths } from "./resolver-backend.ts"

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
	setEnv("MAILWOMAN_CANDIDATE_DB", undefined)
	expect(resolveCandidateDBPath()).toBeUndefined() // unset
	expect(resolveCandidateDBPath("/no/such/candidate.db")).toBeUndefined() // explicit but missing
	expect(resolveCandidateDBPath(THIS_FILE)).toBe(THIS_FILE) // explicit + exists

	setEnv("MAILWOMAN_CANDIDATE_DB", THIS_FILE)
	expect(resolveCandidateDBPath()).toBe(THIS_FILE) // from env + exists
	setEnv("MAILWOMAN_CANDIDATE_DB", "/no/such/candidate.db")
	expect(resolveCandidateDBPath()).toBeUndefined() // env path missing
})
