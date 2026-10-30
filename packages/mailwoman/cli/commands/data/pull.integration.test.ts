/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The first-run and precision-upgrade commands on the compiled CLI, against a local fixture registry.
 *
 *   An empty data root takes `data pull candidate`, then `data pull us --only dc`, through `--host`, and
 *   `geocode` answers the District of Columbia address from the installed selection at the rooftop tier.
 *   The fixture registry serves a candidate gazetteer built from a three-place admin database and one
 *   address point, under the published object keys. Run `yarn compile` before this suite.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseJSONStrict } from "@mailwoman/core/json"
import { artifactIDFromSHA256, ServingRole } from "@mailwoman/core/layers"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build/candidate"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilder, resolvePath } from "path-ts"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"

import { stripAnsi } from "#cli-kit"
import { BUNDLES } from "#data/bundles"
import { LayerCatalog, readInstalledManifest } from "#data/catalog"
import { mailwomanCLIPath } from "#metadata"
import { withCLISpawnLockAsync } from "#test-kit/cli-spawn-lock"
import {
	FIXTURE_DC_POINT,
	FixtureRegistry,
	writeFixtureAddressPoints,
	writeFixtureInterpolation,
} from "#test-kit/fixture-registry"

const CLI_SPAWN_TIMEOUT_MS = 120_000

vi.setConfig({ testTimeout: 600_000 })

const cliBin = await mailwomanCLIPath()

/**
 * The United States, the District of Columbia and Washington, as a WOF admin database.
 */
function writeFixtureAdmin(path: PathBuilder): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT);
		CREATE TABLE place_abbr (id INTEGER PRIMARY KEY, abbr TEXT);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

		INSERT INTO spr VALUES (1, 'United States', 'country', 'US', 39.8, -98.5, 18.9, -179.2, 71.4, -66.9, -1, 0);
		INSERT INTO spr VALUES (2, 'District of Columbia', 'region', 'US', 38.9, -77.02, 38.79, -77.12, 39.0, -76.9, -1, 0);
		INSERT INTO spr VALUES (3, 'Washington', 'locality', 'US', 38.9, -77.03, 38.79, -77.12, 39.0, -76.9, -1, 0);
		INSERT INTO place_population VALUES (1, 330000000);
		INSERT INTO place_population VALUES (2, 690000);
		INSERT INTO place_population VALUES (3, 690000);
		INSERT INTO place_abbr VALUES (2, 'DC');
		INSERT INTO ancestors VALUES (2, 1, 'country');
		INSERT INTO ancestors VALUES (3, 2, 'region');
		INSERT INTO ancestors VALUES (3, 1, 'country');
	`)
}

const registry = new FixtureRegistry()
let fixtures: TemporaryDirectory
let root: TemporaryDirectory

beforeAll(async () => {
	fixtures = await temporaryDirectory("mw-cli-registry-")
	root = await temporaryDirectory("mw-cli-root-")

	writeFixtureAdmin(fixtures.path("admin.db"))
	await buildCandidateTable({ input: fixtures.path("admin.db"), output: fixtures.path("candidate.db") })
	await writeFixtureAddressPoints(fixtures.path("dc-situs.db"))
	await writeFixtureInterpolation(fixtures.path("dc-interp.db"))

	const candidate = BUNDLES["candidate"]!.artifacts[0]!
	const dc = BUNDLES["us"]!.artifacts.filter((artifact) => artifact.stateSlug === "dc")

	registry.put(candidate.remotePath, await readLocalBuffer(fixtures.path("candidate.db")))

	for (const artifact of dc) {
		const file = artifact.family === "address-points" ? "dc-situs.db" : "dc-interp.db"

		registry.put(artifact.remotePath, await readLocalBuffer(fixtures.path(file)))
	}

	await registry.start()
})

afterAll(async () => {
	await registry[Symbol.asyncDispose]()
	await root[Symbol.asyncDispose]()
	await fixtures[Symbol.asyncDispose]()
})

/**
 * Run the compiled CLI with the fixture data root, answering its exit status and output.
 */
async function cli(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	return cliIn(root.path.toString(), ...args)
}

/**
 * Run the compiled CLI with `dataRoot` as its data root, answering its exit status and output.
 */
async function cliIn(dataRoot: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	return withCLISpawnLockAsync(() =>
		runFile(process.execPath, [cliBin, ...args], {
			env: childEnv({
				NODE_NO_WARNINGS: "1",
				MAILWOMAN_DATA_ROOT: dataRoot,
				MAILWOMAN_CANDIDATE_DB: undefined,
				MAILWOMAN_WOF_DB: undefined,
			}),
			maxBuffer: 16 * 1024 * 1024,
			timeout: CLI_SPAWN_TIMEOUT_MS,
		}).then(
			({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
			(error: { code?: number; stdout?: string; stderr?: string }) => ({
				status: typeof error.code === "number" ? error.code : 1,
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
			})
		)
	)
}

describe("mailwoman data pull from an empty data root", () => {
	test("installs the gazetteer, then the District of Columbia, and geocodes through the selection", async () => {
		const host = ["--host", registry.baseURL]

		// Setup's next installation is a command that runs as printed.
		const setup = await cli("setup", "--no-interactive", "--countries", "US")

		expect(setup.status).toBe(0)
		expect(setup.stdout).toMatch(/parsing\s+available/u)
		expect(setup.stdout).toMatch(/place resolution\s+unavailable/u)

		expect(setup.stdout).toMatch(/Next installation:\s+mailwoman data pull candidate /u)

		const dry = await cli("data", "pull", "candidate", "--dry-run", ...host)

		expect(dry.status).toBe(0)
		expect(registry.requests).toEqual([])
		await expect(pathExists(root.path("active.json"))).resolves.toBe(false)

		const candidate = await cli("data", "pull", "candidate", ...host)

		expect(candidate.status).toBe(0)
		await expect(pathExists(root.path("active.json"))).resolves.toBe(true)

		const dcDry = await cli("data", "pull", "us", "--only", "dc", "--dry-run", ...host)

		expect(dcDry.status).toBe(0)
		expect(dcDry.stdout).toContain("street/us/dc/situs.db")
		expect(dcDry.stdout).not.toContain("street/us/al/")

		const dcPull = await cli("data", "pull", "us", "--only", "dc", ...host)

		expect(dcPull.status).toBe(0)
		expect(registry.requests.some((line) => /street\/us\/(?!dc\/)/u.test(line))).toBe(false)

		const transfers = registry.requests.length
		const again = await cli("data", "pull", "us", "--only", "dc", ...host)

		expect(again.status).toBe(0)
		expect(again.stdout).toContain("reused")
		expect(registry.requests).toHaveLength(transfers)

		const status = await cli("data", "status", "candidate", "--json")

		expect(status.status).toBe(0)

		expect(parseJSONStrict<{ generation: number; artifacts: Array<{ state: string }> }>(status.stdout)).toMatchObject({
			generation: 2,
			artifacts: [{ state: "active" }],
		})

		const after = await cli("setup", "--no-interactive", "--countries", "US")

		expect(after.stdout).toMatch(/place resolution\s+available/u)
		// Ink wraps a line at the terminal width, so the match allows a break between any two words.
		expect(after.stdout).toMatch(/rooftop lookup\s+partial\s+installed for 1 of \d+ published scopes\s+\(US-DC\)/u)

		const geocode = await cli("geocode", "1275 Pennsylvania Ave NW, Washington, DC 20004", "--format", "json")

		expect(geocode.status, geocode.stderr).toBe(0)

		const result = parseJSONStrict<{ resolution_tier?: string; lat?: number; lon?: number }>(geocode.stdout)

		expect(result).toMatchObject({ resolution_tier: "address_point", ...FIXTURE_DC_POINT })
	})
})

describe("mailwoman data pull --force over a corrupted installed artifact", () => {
	test("replaces bytes that no longer hash to the artifact's identity", async () => {
		await using repair = await temporaryDirectory("mw-cli-repair-")
		const dataRoot = repair.path.toString()
		const host = ["--host", registry.baseURL]

		expect((await cliIn(dataRoot, "data", "pull", "candidate", ...host)).status).toBe(0)

		const catalog = await LayerCatalog.read(dataRoot)
		const path = await catalog.firstPath(ServingRole.Candidate, { country: null, subdivision: null })

		if (path == null) throw new Error("the candidate pull selected no candidate artifact")

		const manifest = await readInstalledManifest(resolvePath(path, ".."))

		if (manifest == null) throw new Error(`no manifest beside ${path}`)

		const original = await readLocalBuffer(path)

		expect(artifactIDFromSHA256(await sha256File(path))).toBe(manifest.id)

		// Flip the last byte, keeping the size, so only a hash tells the copies apart.
		const corrupted = Buffer.from(original)
		const last = corrupted.length - 1

		corrupted.writeUInt8(corrupted.readUInt8(last) ^ 0xff, last)
		// The installer seals the file read-only, so the test lifts that to write the bad bytes.
		await changeMode(path, 0o644)
		await writeLocalBuffer(corrupted, path)

		expect((await statPath(path)).size).toBe(original.length)
		expect(artifactIDFromSHA256(await sha256File(path))).not.toBe(manifest.id)

		// Without --force the installed copy is verified, and the corruption is reported.
		const plain = await cliIn(dataRoot, "data", "pull", "candidate", ...host)

		expect(plain.status).not.toBe(0)

		// Ink wraps a line at the terminal width, so the match allows a break between any two words.
		expect(stripAnsi(`${plain.stdout}\n${plain.stderr}`)).toMatch(
			/failed\s+verification:[\s\S]*Pull\s+again\s+with\s+--force/u
		)

		const forced = await cliIn(dataRoot, "data", "pull", "candidate", "--force", ...host)

		expect(forced.status, forced.stderr).toBe(0)
		expect(artifactIDFromSHA256(await sha256File(path))).toBe(manifest.id)
		expect((await readLocalBuffer(path)).equals(original)).toBe(true)
	})
})
