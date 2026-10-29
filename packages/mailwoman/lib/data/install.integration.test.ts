/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The published-installation path end to end, against a local fixture registry and a temporary data root.
 *
 *   An empty data root installs the candidate gazetteer, then the District of Columbia's address points and
 *   interpolation without any other state, and the place and street readers resolve both through `active.json`.
 *   A repeated pull reuses every artifact with zero requests. An interrupted transfer resumes from its partial bytes, a changed remote
 *   object restarts, a failed sibling leaves its bundle unselected, and two installers planned against one
 *   generation select once.
 */

import { APIClient } from "@mailwoman/core/api"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { ServingRole } from "@mailwoman/core/layers"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite/address"
import { StreetInterpolator } from "@mailwoman/resolver-wof-sqlite/interpolation"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { BUNDLES, type DataBundle } from "#data/bundles"
import { catalogPaths, LayerCatalog, readActiveSelection } from "#data/catalog"
import { ArtifactOutcome, executeInstallation, type InstallationResult } from "#data/install"
import { takeInventory } from "#data/inventory"
import { planInstallation, PlannedAction, type InstallationRequest } from "#data/plan"
import { readInstallationState } from "#data/state"
import { USStateDatabaseProvider } from "#geocode/regions"
import { resolveCandidateDBPath } from "#resolver-backend"
import {
	FIXTURE_DC_POINT,
	FIXTURE_DC_STREET,
	FixtureRegistry,
	writeFixtureAddressPoints,
	writeFixtureInterpolation,
} from "#test-kit/fixture-registry"

/**
 * The one table of the stand-in gazetteer, enough to tell the selected file from any other.
 */
interface FixtureGazetteerDatabase {
	fixture_candidate: { name: string }
}

function writeFixtureGazetteer(path: PathBuilder): void {
	using db = new DatabaseClient<FixtureGazetteerDatabase>(path)

	db.exec("CREATE TABLE fixture_candidate (name TEXT); INSERT INTO fixture_candidate VALUES ('Washington')")
}

const registry = new FixtureRegistry()
let fixtures: TemporaryDirectory
let scratch: TemporaryDirectory

/**
 * The published registry's rights and roles over the fixture objects: one candidate, DC and Alabama.
 */
let REGISTRY: Record<string, DataBundle>

beforeAll(async () => {
	fixtures = await temporaryDirectory("mw-fixture-registry-")

	writeFixtureGazetteer(fixtures.path("candidate.db"))
	await writeFixtureAddressPoints(fixtures.path("dc-situs.db"))
	await writeFixtureInterpolation(fixtures.path("dc-interp.db"))
	await writeFixtureAddressPoints(fixtures.path("al-situs.db"))

	const objects = {
		"gazetteer/fixture/candidate.db": "candidate.db",
		"street/us/dc/situs.db": "dc-situs.db",
		"street/us/dc/fixture/interp.db": "dc-interp.db",
		"street/us/al/situs.db": "al-situs.db",
	}

	for (const [key, file] of Object.entries(objects)) {
		registry.put(key, await readLocalBuffer(fixtures.path(file)))
	}

	const size = (key: string) => registry.objects.get(key)!.body.length

	REGISTRY = {
		candidate: {
			...BUNDLES["candidate"]!,
			artifacts: [
				{
					remotePath: "gazetteer/fixture/candidate.db",
					localPath: "wof/candidate.db",
					md5Sidecar: false,
					approxBytes: size("gazetteer/fixture/candidate.db"),
				},
			],
		},
		us: {
			...BUNDLES["us"]!,
			artifacts: [
				{
					remotePath: "street/us/al/situs.db",
					localPath: "address-points/address-points-us-al.db",
					md5Sidecar: false,
					approxBytes: size("street/us/al/situs.db"),
					family: "address-points",
					stateSlug: "al",
				},
				{
					remotePath: "street/us/dc/situs.db",
					localPath: "address-points/address-points-us-dc.db",
					md5Sidecar: false,
					approxBytes: size("street/us/dc/situs.db"),
					family: "address-points",
					stateSlug: "dc",
				},
				{
					remotePath: "street/us/dc/fixture/interp.db",
					localPath: "interpolation/interpolation-us-dc.db",
					md5Sidecar: false,
					approxBytes: size("street/us/dc/fixture/interp.db"),
					family: "interpolation",
					stateSlug: "dc",
				},
			],
		},
	}

	await registry.start()
})

afterAll(async () => {
	await registry[Symbol.asyncDispose]()
	await fixtures[Symbol.asyncDispose]()
})

beforeEach(async () => {
	scratch = await temporaryDirectory("mw-install-root-")
	registry.requests.length = 0
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

function request(bundles: string[], only?: string): InstallationRequest {
	return {
		bundles,
		only: only ?? null,
		dataRoot: scratch.path,
		host: registry.baseURL,
		registry: REGISTRY,
	}
}

async function pull(bundles: string[], only?: string): Promise<InstallationResult> {
	const plan = await planInstallation(request(bundles, only))

	await using client = new APIClient({ displayName: "fixture", retry: false })

	// Awaited here so the client is disposed once the installation settles.
	return await executeInstallation(plan, { client })
}

const DC_QUERY = { street: FIXTURE_DC_STREET, number: "1275", postcode: "20004", bbox: null }

const factory = {
	AddressPointSqliteLookup: AddressPointSqliteLookup as unknown as new (path: string) => AddressPointSqliteLookup,
	StreetInterpolator,
}

describe("the published installation path", () => {
	it("plans without writing anything, then installs the candidate into an immutable location and selects it", async () => {
		const plan = await planInstallation(request(["candidate"]))

		expect(plan.bundles[0]!.artifacts.map((artifact) => artifact.action)).toEqual([PlannedAction.Download])
		expect(plan.basedOnGeneration).toBeNull()
		expect(plan.transfer.basis).toBe("estimated")
		expect(registry.requests).toEqual([])
		expect(await pathExists(scratch.path("active.json"))).toBe(false)
		expect(await pathExists(scratch.path("db"))).toBe(false)

		const result = await pull(["candidate"])

		expect(result.ok).toBe(true)
		expect(result.selection?.generation).toBe(1)

		const candidate = await resolveCandidateDBPath(undefined, scratch.path)

		expect(candidate).toMatch(new RegExp(`${scratch.path("db", "candidate")}/[0-9a-f]{64}/candidate\\.db$`, "u"))

		using db = new DatabaseClient<FixtureGazetteerDatabase>(candidate!, { readOnly: true })

		expect(db.prepare("SELECT name FROM fixture_candidate").get()).toEqual({ name: "Washington" })
		// The conventional path stays empty.
		// The file's location is recorded in the selection.
		expect(await pathExists(scratch.path("db", "wof", "candidate.db"))).toBe(false)
	})

	it("adds the District of Columbia without transferring another state, and the street reader resolves it", async () => {
		await pull(["candidate"])
		registry.requests.length = 0

		const plan = await planInstallation(request(["us"], "dc"))

		expect(plan.bundles[0]!.missingDependencies).toEqual([])

		expect(plan.bundles[0]!.artifacts.map((artifact) => artifact.artifact.remotePath)).toEqual([
			"street/us/dc/situs.db",
			"street/us/dc/fixture/interp.db",
		])

		const result = await pull(["us"], "dc")

		expect(result.ok).toBe(true)
		expect(result.selection?.generation).toBe(2)
		expect(registry.requests.some((line) => line.includes("/al/"))).toBe(false)

		using provider = await USStateDatabaseProvider.create(factory, scratch.path)
		const dc = provider.for("dc")

		expect(dc.addressPoints?.find(DC_QUERY)).toMatchObject(FIXTURE_DC_POINT)
		expect(dc.interpolation).toBeTruthy()
		expect(provider.for("al").addressPoints).toBeFalsy()
	})

	it("reports a missing gazetteer as a dependency of the street tier", async () => {
		const plan = await planInstallation(request(["us"], "dc"))

		expect(plan.bundles[0]!.missingDependencies).toEqual(["candidate"])
	})

	it("verifies and reuses completed artifacts on a repeated pull, transferring nothing", async () => {
		await pull(["candidate"])
		await pull(["us"], "dc")
		registry.requests.length = 0

		const results = [await pull(["candidate"]), await pull(["us"], "dc")]

		expect(results.map((result) => [result.ok, result.selection])).toEqual([
			[true, null],
			[true, null],
		])

		expect(results.flatMap((result) => result.results.map((artifact) => artifact.outcome))).toEqual([
			ArtifactOutcome.Reused,
			ArtifactOutcome.Reused,
			ArtifactOutcome.Reused,
		])

		expect(registry.requests).toEqual([])
		expect((await readActiveSelection(scratch.path))?.generation).toBe(2)
	})

	it("keeps an interrupted transfer's bytes, leaves the selection as it was, and resumes on the next pull", async () => {
		await pull(["candidate"])
		registry.interruptAfter.set("street/us/dc/situs.db", 4096)

		const failed = await pull(["us"], "dc")

		expect(failed.ok).toBe(false)
		expect(failed.selection).toBeNull()
		expect((await readActiveSelection(scratch.path))?.generation).toBe(1)

		using before = await USStateDatabaseProvider.create(factory, scratch.path)

		expect(before.for("dc").addressPoints).toBeFalsy()

		// The diagnostics report the stopped transfer and the unselected sibling apart from the active gazetteer.
		const state = await readInstallationState(scratch.path)

		expect(state.generation).toBe(1)
		expect(state.active.map((copy) => copy.receipt?.remotePath)).toEqual(["gazetteer/fixture/candidate.db"])
		expect(state.inactive.map((copy) => copy.receipt?.remotePath)).toEqual(["street/us/dc/fixture/interp.db"])
		expect(state.interrupted).toMatchObject([{ remotePath: "street/us/dc/situs.db", partialBytes: 4096 }])

		const inventory = await takeInventory({ dataRoot: scratch.path, installation: state })

		expect(inventory.entries.map((entry) => entry.selection).toSorted()).toEqual(["active", "inactive"])

		registry.requests.length = 0

		const resumed = await pull(["us"], "dc")

		expect(resumed.ok).toBe(true)
		expect(registry.requests).toContain("GET street/us/dc/situs.db bytes=4096-")
		expect(resumed.selection?.generation).toBe(2)

		using after = await USStateDatabaseProvider.create(factory, scratch.path)

		expect(after.for("dc").addressPoints?.find(DC_QUERY)).toMatchObject(FIXTURE_DC_POINT)
	})

	it("restarts rather than resumes when the remote object changed, and says why", async () => {
		await pull(["candidate"])
		registry.interruptAfter.set("street/us/dc/situs.db", 4096)
		await pull(["us"], "dc")

		const original = registry.objects.get("street/us/dc/situs.db")!

		registry.put("street/us/dc/situs.db", original.body, '"republished"')
		registry.requests.length = 0

		const progress: string[] = []
		const plan = await planInstallation(request(["us"], "dc"))

		await using client = new APIClient({ displayName: "fixture", retry: false })

		const result = await executeInstallation(plan, { client, onProgress: (line) => progress.push(line) })

		registry.put("street/us/dc/situs.db", original.body, original.etag)

		expect(result.ok).toBe(true)

		expect(
			progress.some((line) => /restarting the transfer of street\/us\/dc\/situs\.db: the ETag changed/u.test(line))
		).toBe(true)

		expect(registry.requests).not.toContain("GET street/us/dc/situs.db bytes=4096-")
	})

	it("selects nothing from a bundle whose sibling failed, then selects it later without a second transfer", async () => {
		await pull(["candidate"])
		registry.missing.add("street/us/dc/fixture/interp.db")

		const failed = await pull(["us"], "dc")

		registry.missing.delete("street/us/dc/fixture/interp.db")

		expect(failed.ok).toBe(false)
		expect((await readActiveSelection(scratch.path))?.generation).toBe(1)

		const plan = await planInstallation(request(["us"], "dc"))

		expect(plan.bundles[0]!.artifacts.map((artifact) => artifact.action)).toEqual([
			PlannedAction.Activate,
			PlannedAction.Download,
		])

		registry.requests.length = 0

		const result = await pull(["us"], "dc")

		expect(result.ok).toBe(true)
		expect(registry.requests.filter((line) => line.startsWith("GET street/us/dc/situs.db"))).toEqual([])
		expect(result.selection?.generation).toBe(2)
	})

	it("selects once when two installers planned against the same generation", async () => {
		await pull(["candidate"])

		const plans = await Promise.all([planInstallation(request(["us"], "dc")), planInstallation(request(["us"], "dc"))])

		await using client = new APIClient({ displayName: "fixture", retry: false })

		const outcomes = await Promise.allSettled(plans.map((plan) => executeInstallation(plan, { client })))
		const completed = outcomes.filter((outcome) => outcome.status === "fulfilled")
		const refused = outcomes.filter((outcome) => outcome.status === "rejected")

		expect(completed.map((outcome) => outcome.value.ok)).toEqual([true])

		expect(refused.map((outcome) => String(outcome.reason))).toEqual([
			expect.stringMatching(/another installer is running under/u),
		])

		// The second plan read generation 1.
		// The first installer replaced it, so activation refuses the second plan.
		const stale = await executeInstallation(plans[1]!, { client })

		expect(stale.selection).toBeNull()

		const catalog = await LayerCatalog.read(scratch.path)

		expect(catalog.generation).toBe(2)
		expect(await catalog.firstPath(ServingRole.AddressPoints, { country: "US", subdivision: "US-DC" })).toBeTruthy()
		expect(await pathExists(catalogPaths(scratch.path).lock)).toBe(false)
		expect(await pathExists(catalogPaths(scratch.path).installLock)).toBe(false)
	})
})
