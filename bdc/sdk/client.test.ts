/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest"

import type { RawBDCFile } from "./common.ts"
import type { FCCAsOfDateEntry } from "./filing-dates.ts"

// `$private` (`@mailwoman/core/env`) is a LIVE getter over `{ ...dotEnv, ...process.env }` — `dotEnv` is
// read from the repo's real `.env` once at module load, so `vi.stubEnv(..., undefined)` alone can't hide
// real FCC_MAP_USERNAME/FCC_MAP_API_KEY values committed there: the merge falls back to `dotEnv`'s value
// regardless of what the test stubs on `process.env`. Mock the module directly so the no-credentials test
// below is isolated from whatever the ambient environment actually contains (live-data finding — this
// broke the first time real credentials landed in `.env`). Every OTHER test in this file passes explicit
// `username`/`apiKey` options and never reads `$private`, so this mock doesn't affect them.
vi.mock("@mailwoman/core/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/core/env")>()

	return {
		...actual,
		$private: { ...actual.$private, FCC_MAP_USERNAME: undefined, FCC_MAP_API_KEY: undefined },
	}
})

// Shared-graph guard: the root vitest config runs `isolate: false`, so `./client.ts` may already sit
// in the worker's cache — evaluated WITHOUT this file's `@mailwoman/core/env` mock by an earlier file
// (a cached module never re-evaluates, and vi.mock factories are only consulted at evaluation). Reset
// on the way in so the chain re-evaluates against the mock, and on the way out so the NEXT file in
// this fork never inherits our mocked env module from the cache.
vi.resetModules()
afterAll(() => vi.resetModules())

// Dynamic imports AFTER the reset so the module chain evaluates against the env mock.
const { createBDCClient } = await import("./client.ts")
const { BDCFileCategory, BDCFilingDataType, BDCStateSubCategory } = await import("./common.ts")
const { resolveLatestVintage, retrieveFilingDates } = await import("./filing-dates.ts")
const { retrieveAvailabilityFiles } = await import("./list-files.ts")

let dataRoot: string

beforeEach(() => {
	dataRoot = mkdtempSync(join(tmpdir(), "bdc-client-test-"))
	vi.stubEnv("MAILWOMAN_DATA_ROOT", dataRoot)
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(dataRoot, { recursive: true, force: true })
})

test("createBDCClient: throws a descriptive error without credentials and without env values", () => {
	vi.stubEnv("FCC_MAP_USERNAME", undefined)
	vi.stubEnv("FCC_MAP_API_KEY", undefined)

	expect(() => createBDCClient()).toThrow(/credentials/i)
})

test("createBDCClient: sends the username/hash_value header auth on every request", async () => {
	let seenHeaders: RequestInit["headers"]
	let seenURL: string | undefined

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		seenHeaders = init?.headers
		seenURL = String(input)

		return new Response(JSON.stringify({ data: [] }))
	}) as typeof fetch

	const client = createBDCClient({ username: "alice", apiKey: "s3cr3t", fetchImpl })
	await client.get("/map/listAsOfDates")

	expect(seenURL).toBe("https://broadbandmap.fcc.gov/api/public/map/listAsOfDates")
	expect(seenHeaders).toMatchObject({ username: "alice", hash_value: "s3cr3t" })
})

test("retrieveFilingDates + resolveLatestVintage: picks the later as_of_date from two entries", async () => {
	const raw: FCCAsOfDateEntry[] = [
		{ data_type: BDCFilingDataType.Availability, as_of_date: "2024-06-30" },
		{ data_type: BDCFilingDataType.Availability, as_of_date: "2024-12-31" },
	]

	const fetchImpl = (async () => new Response(JSON.stringify({ data: raw }))) as typeof fetch
	const client = createBDCClient({ username: "alice", apiKey: "s3cr3t", fetchImpl })

	const entries = await retrieveFilingDates(client, { filingType: BDCFilingDataType.Availability })

	expect(entries).toHaveLength(2)

	const latest = resolveLatestVintage(entries, BDCFilingDataType.Availability)

	expect(latest).toBe("2024-12-31")
})

test("retrieveAvailabilityFiles: parses raw entries into BDCFile[] sorted ascending by revision", async () => {
	const rawFiles: RawBDCFile[] = [
		{
			file_id: 1,
			category: BDCFileCategory.State,
			subcategory: BDCStateSubCategory.FixedBroadband,
			technology_code: "10",
			technology_code_desc: "Asymmetric xDSL",
			state_fips: "06",
			state_name: "California",
			provider_id: "1",
			provider_name: "Example One",
			file_type: "csv",
			file_name: "bdc_06_Cable_D23_31dec2024",
			record_count: "1",
		},
		{
			file_id: 2,
			category: BDCFileCategory.State,
			subcategory: BDCStateSubCategory.FixedBroadband,
			technology_code: "10",
			technology_code_desc: "Asymmetric xDSL",
			state_fips: "06",
			state_name: "California",
			provider_id: "2",
			provider_name: "Example Two",
			file_type: "csv",
			file_name: "bdc_06_Cable_D23_01jan2023",
			record_count: "1",
		},
	]

	const fetchImpl = (async () => new Response(JSON.stringify({ data: rawFiles }))) as typeof fetch
	const client = createBDCClient({ username: "alice", apiKey: "s3cr3t", fetchImpl })

	const files = await retrieveAvailabilityFiles(client, {
		asOfDate: "2024-12-31",
		category: BDCFileCategory.State,
		subcategory: BDCStateSubCategory.FixedBroadband,
	})

	expect(files.map((file) => file.fileID)).toEqual([2, 1])
	expect(files.every((file) => file instanceof Object)).toBe(true)
})
