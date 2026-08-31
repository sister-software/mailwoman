/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two arm kinds that are not a live geocoder: a metered reference oracle, and a stored past run.
 *
 *   Separate from `compare.test.ts` because neither touches the HTTP transport, and because both are about the same
 *   thing — a comparison that must NOT produce a verdict, for two different reasons.
 */

import { createPostalAddressID } from "@mailwoman/address-id"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { runCompare } from "@mailwoman/dev-mcp/compare"
import type { EngineRegistryLike } from "@mailwoman/dev-mcp/engine-registry"
import { OracleMeter, OracleProviderName, type OracleGeocoderLike } from "@mailwoman/dev-mcp/oracle-arm"
import { listRuns } from "@mailwoman/dev-mcp/run-store"
import { afterAll, describe, expect, it } from "vitest"

import { stubEngine, stubEngineRegistry } from "#test/stub-registry"

const RUN_STORE = await temporaryDirectory("mwdev-arms-runs-")

afterAll(() => RUN_STORE[Symbol.asyncDispose]())

const ANDORRA_LA_VELLA = { lat: 42.5063174, lon: 1.5218355 }

/**
 * A registry whose engine answers one fixed coordinate. `hierarchy` is present because the mailwoman arm reads its
 * answer through the gauntlet projection, which walks it.
 */
function registryAt(point: { lat: number | null; lon: number | null }): EngineRegistryLike {
	const engine = stubEngine({
		engineID: "stub",
		effective: { locale: "en-US" },
		fingerprint: { digest: "tree0", gitHead: "head0", dirtyFiles: [] as string[] },
		buildMs: 1,
		uses: 1,
		session: {
			geocode: async () => ({
				result: {
					components: {},
					lat: point.lat,
					lon: point.lon,
					resolution_tier: point.lat === null ? "none" : "admin",
					locality: "stub",
					region: null,
					hierarchy: [],
				},
				timing: { total: 1 },
			}),
			[Symbol.dispose]: () => undefined,
		},
	})

	return stubEngineRegistry({
		repoRoot: "/tmp/stub",
		maxResident: 2,
		size: 1,
		fingerprint: async () => ({
			digest: "tree0",
			gitHead: "head0",
			dirtyFiles: [],
			newestMtimeMs: 0,
			newestPath: null,
			filesWalked: 1,
		}),
		acquire: async () => engine,
		summaries: () => [],
		evict: () => true,
		evictAll: () => 0,
	})
}

/**
 * An oracle client that answers one fixed point, and counts what it was asked.
 */
function oracleAt(point: { lat: number; lon: number }): OracleGeocoderLike & { calls: string[] } {
	const calls: string[] = []

	return {
		calls,
		geocodeOne: async (input) => {
			calls.push(input)

			return [
				{
					provider: OracleProviderName.Census,
					address: {
						components: {},
						canonicalKey: "stub",
						formatted: "Stub, AD",
						geocode: {
							coordinate: { latitude: point.lat, longitude: point.lon },
							tier: "admin",
							uncertaintyMeters: null,
						},
					},
					addressID: createPostalAddressID({
						coordinate: { latitude: point.lat, longitude: point.lon },
						address: "Stub, AD",
					}),
					partialMatch: false,
					placeID: null,
					plusCode: null,
					raw: undefined,
				},
			]
		},
		[Symbol.asyncDispose]: async () => undefined,
	}
}

const BOARD_AD = { kind: "board", country: "AD" }

describe("mwdev_compare — an oracle arm", () => {
	it("refuses to grade even when every row carries a truth coordinate", async () => {
		// The board's AD rows all pin expectLat/expectLon, so this comparison COULD be graded on distance. It is not,
		// because the board's coordinates were pinned by hand with these same geocoders open as a second opinion.
		const oracle = oracleAt(ANDORRA_LA_VELLA)

		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: BOARD_AD,
				arm_a: {},
				arm_b: { kind: "oracle", provider: "census" },
				variable: ["engine"],
				grade: "truth",
			},
			{ createOracleClient: () => oracle, runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		expect(result["grade_mode"]).toBe("diff-only")
		expect(result["verdict"]).toBeNull()
		expect(result["significance"]).toBeNull()
		expect(result["equivalence"]).toBeNull()
		expect(String(result["summary"])).toContain("never a grading truth")
		expect((result["graded"] as Record<string, number>)["ungradeable"]).toBe(oracle.calls.length)
	})

	it('honours `grade: "truth"` by refusing rather than by grading', async () => {
		// `resolveGradeMode` throws for a request it cannot meet. The oracle refusal must not turn that into a silent
		// downgrade either — the caller asked for a verdict and gets a stated reason there is none.
		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: BOARD_AD,
				arm_a: {},
				arm_b: { kind: "oracle", provider: "census" },
				variable: ["engine"],
				grade: "truth",
			},
			{ createOracleClient: () => oracleAt(ANDORRA_LA_VELLA), runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		expect(String(result["verdict_withheld_reason"])).toContain("do not read a score")
	})

	it("sends the raw query with no country hint, so the oracle is not flattered", async () => {
		const oracle = oracleAt(ANDORRA_LA_VELLA)

		await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: { kind: "literal", inputs: ["Andorra la Vella"], why: "one row, to read what reached the oracle" },
				arm_a: {},
				arm_b: { kind: "oracle", provider: "census" },
				variable: ["engine"],
			},
			{ createOracleClient: () => oracle, runStoreDir: RUN_STORE.path }
		)

		expect(oracle.calls).toEqual(["Andorra la Vella"])
	})

	it("refuses a Google arm the daemon config does not enable, before any query", async () => {
		const oracle = oracleAt(ANDORRA_LA_VELLA)

		await expect(
			runCompare(
				registryAt(ANDORRA_LA_VELLA),
				{ inputs: BOARD_AD, arm_a: {}, arm_b: { kind: "oracle", provider: "google" }, variable: ["engine"] },
				{ createOracleClient: () => oracle, oracleMeter: new OracleMeter({}), runStoreDir: RUN_STORE.path }
			)
		).rejects.toThrow(/BILLED and is not enabled/)

		expect(oracle.calls).toEqual([])
	})

	it("refuses a Google run larger than the remaining cap, before any query", async () => {
		const oracle = oracleAt(ANDORRA_LA_VELLA)
		const meter = new OracleMeter({ google: { enabled: true, maxCallsPerDaemonLifetime: 1 } })

		await expect(
			runCompare(
				registryAt(ANDORRA_LA_VELLA),
				{ inputs: BOARD_AD, arm_a: {}, arm_b: { kind: "oracle", provider: "google" }, variable: ["engine"] },
				{ createOracleClient: () => oracle, oracleMeter: meter, runStoreDir: RUN_STORE.path }
			)
		).rejects.toThrow(/Refusing before spending/)

		expect(oracle.calls).toEqual([])
		expect(meter.googleCallsUsed).toBe(0)
	})

	it("spends the meter one call per row on an admitted Google run", async () => {
		const meter = new OracleMeter({ google: { enabled: true, maxCallsPerDaemonLifetime: 10 } })

		await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: { kind: "literal", inputs: ["one", "two"], why: "two rows, to read the meter" },
				arm_a: {},
				arm_b: { kind: "oracle", provider: "google" },
				variable: ["engine"],
			},
			{ createOracleClient: () => oracleAt(ANDORRA_LA_VELLA), oracleMeter: meter, runStoreDir: RUN_STORE.path }
		)

		expect(meter.googleCallsUsed).toBe(2)
		expect(meter.admit(OracleProviderName.Google, 1).callsRemaining).toBe(8)
	})
})

describe("mwdev_compare — a truthless comparison", () => {
	it("reports arm separation rather than a fabricated zero", async () => {
		// The failure this closes: without truth both distances are null, so the threshold rule finds no verdict to
		// cross and every row reads as identical. `describeObservedRate` then turns "0 of N differed" into "tight enough
		// to read as a real absence" — a claim of no difference between two arms that never agreed on anything.
		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: { kind: "literal", inputs: ["somewhere"], why: "a set with no truth" },
				arm_a: {},
				arm_b: { kind: "oracle", provider: "census" },
				variable: ["engine"],
			},
			// The oracle answers Paris; the mailwoman stub answers Andorra. ~800 km apart.
			{ createOracleClient: () => oracleAt({ lat: 48.8566, lon: 2.3522 }), runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		expect(result["differed_basis"]).toBe("arm-separation")
		expect(result["arms_differed_on"]).toEqual({ n: 1, of: 1 })
		expect(String(result["arms_differed_on_note"])).toContain("no truth coordinate")
	})

	it("does not call two arms that landed together a difference", async () => {
		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: { kind: "literal", inputs: ["somewhere"], why: "a set with no truth" },
				arm_a: {},
				arm_b: { kind: "oracle", provider: "census" },
				variable: ["engine"],
			},
			{ createOracleClient: () => oracleAt(ANDORRA_LA_VELLA), runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		expect(result["arms_differed_on"]).toEqual({ n: 0, of: 1 })
	})
})

describe("mwdev_compare — a recorded arm", () => {
	async function record(): Promise<string> {
		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: BOARD_AD,
				arm_a: {},
				arm_b: { kind: "oracle", provider: "census" },
				variable: ["engine"],
			},
			{ createOracleClient: () => oracleAt(ANDORRA_LA_VELLA), runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		return result["run_id"] as string
	}

	it("stores every comparison under a run_id the result reports", async () => {
		const runID = await record()

		expect(runID).toBeTruthy()
		expect((await listRuns(RUN_STORE.path)).some((run) => run.run_id === runID)).toBe(true)
	})

	it("replays a stored arm without re-running it", async () => {
		const runID = await record()
		const oracle = oracleAt(ANDORRA_LA_VELLA)

		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: BOARD_AD,
				arm_a: { kind: "recorded", run_id: runID, arm: "oracle:census" },
				arm_b: {},
				variable: ["tree_fingerprint"],
			},
			{ createOracleClient: () => oracle, runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		// The whole point: the oracle was not consulted a second time.
		expect(oracle.calls).toEqual([])
		expect(result["n_no_result_a"]).toBe(0)
		expect(String(result["summary"])).toContain("recorded:oracle:census")
	})

	it("names the recorded tree so a cross-tree comparison cannot be read as a clean one", async () => {
		const runID = await record()

		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: BOARD_AD,
				arm_a: { kind: "recorded", run_id: runID, arm: "oracle:census" },
				arm_b: {},
				variable: ["tree_fingerprint"],
			},
			{ createOracleClient: () => oracleAt(ANDORRA_LA_VELLA), runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		expect((result["warnings"] as string[]).join(" ")).toContain("Declare tree_fingerprint as a variable")
		expect((result["provenance_a"] as Record<string, unknown>)["recorded_tree_fingerprint"]).toBe("tree0")
	})

	it("scores a row the stored run never saw as a no-result, and says how many", async () => {
		const runID = await record()

		const result = (await runCompare(
			registryAt(ANDORRA_LA_VELLA),
			{
				inputs: { kind: "literal", inputs: ["a row that run never saw"], why: "a set the stored run does not cover" },
				arm_a: { kind: "recorded", run_id: runID, arm: "oracle:census" },
				arm_b: {},
				variable: ["tree_fingerprint"],
			},
			{ createOracleClient: () => oracleAt(ANDORRA_LA_VELLA), runStoreDir: RUN_STORE.path }
		)) as Record<string, unknown>

		expect(result["n_no_result_a"]).toBe(1)
		expect((result["warnings"] as string[]).join(" ")).toContain("1 of 1 rows in this set are not in run")
	})

	it("refuses a run_id that is not in the store rather than measuring an empty arm", async () => {
		await expect(
			runCompare(
				registryAt(ANDORRA_LA_VELLA),
				{
					inputs: BOARD_AD,
					arm_a: { kind: "recorded", run_id: "no-such-run" },
					arm_b: {},
					variable: ["tree_fingerprint"],
				},
				{ runStoreDir: RUN_STORE.path }
			)
		).rejects.toThrow(/pruned or never existed/)
	})

	it("refuses a side the stored run did not record, and names the sides it did", async () => {
		const runID = await record()

		await expect(
			runCompare(
				registryAt(ANDORRA_LA_VELLA),
				{
					inputs: BOARD_AD,
					arm_a: { kind: "recorded", run_id: runID, arm: "photon" },
					arm_b: {},
					variable: ["tree_fingerprint"],
				},
				{ runStoreDir: RUN_STORE.path }
			)
		).rejects.toThrow(/It recorded: mailwoman, oracle:census\./)
	})
})
