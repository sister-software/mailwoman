/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A cross-engine comparison end to end: a stub registry for the mailwoman arm, a scripted Axios adapter for the
 *   external one, and a real board slice for the truth coordinates.
 *
 *   The slice is `AD` — two rows, both carrying a truth coordinate — so the arithmetic in every assertion below can be
 *   checked by hand against the two answers the stubs give.
 */

import type { Engine } from "../../engine-registry.ts"
import { stubEngine, stubEngineRegistry } from "../stub-registry.ts"
import { stubTransport } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { ExternalArm } from "@mailwoman/dev-mcp/arms"
import { runCompare } from "@mailwoman/dev-mcp/compare"
import type { EngineRegistryLike } from "@mailwoman/dev-mcp/engine-registry"
import { ExternalGeocoderClient } from "@mailwoman/dev-mcp/external-arm"
import { afterAll, describe, expect, it } from "vitest"

/**
 * Every comparison writes its answers to the run store. Redirected here so a test run never touches the operator's
 * store under `$MAILWOMAN_DATA_ROOT`, and so the retention sweep each write triggers has nothing real to prune.
 */
const RUN_STORE = await temporaryDirectory("mwdev-compare-runs-")

afterAll(() => RUN_STORE[Symbol.asyncDispose]())

/**
 * Andorra la Vella and Les Escaldes, the two `AD` board rows, and their truth coordinates.
 */
const ANDORRA_LA_VELLA = { lat: 42.5063174, lon: 1.5218355 }
const LES_ESCALDES = { lat: 42.5100804, lon: 1.5387862 }

const PELIAS_ARM: ExternalArm = { kind: "external", engine: "pelias", endpoint: "http://127.0.0.1:4000" }

/**
 * A registry whose engine answers a fixed coordinate for every input.
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
					// Required on `GeocodeResult`, and the mailwoman arm reads its answer through the gauntlet projection —
					// which walks it. A double missing it throws inside the arm, and every row then scores as a query
					// failure, which reads as an arm that lost.
					// A stated identity, so the tri-state pin below proves the ONE-SIDED case: the mailwoman
					// arm carries place_ids and the external arm cannot — incomparable, never "same".
					hierarchy: [{ tag: "locality", value: "stub", name: "stub", placeID: "wof:101" }],
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
		fingerprint: () => ({
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

function peliasBody(point: { lat: number; lon: number } | null) {
	return {
		geocoding: { version: "0.2", engine: { name: "Pelias", version: "1.0" } },
		type: "FeatureCollection",
		features: point
			? [
					{
						type: "Feature",
						geometry: { type: "Point", coordinates: [point.lon, point.lat] },
						properties: { layer: "locality", name: "stub" },
					},
				]
			: [],
	}
}

/**
 * @param outcomes Scripted wire responses AFTER the identity probe's two requests, in row order.
 */
async function comparison(
	registry: EngineRegistryLike,
	outcomes: Parameters<typeof stubTransport>[0],
	args: Record<string, unknown> = {}
) {
	const transport = stubTransport([
		// The identity probe: the status path, then one throwaway search.
		{ status: 200, body: "status: ok" },
		{ body: peliasBody(ANDORRA_LA_VELLA) },
		...outcomes,
	])

	return (await runCompare(
		registry,
		{
			inputs: { kind: "board", country: "AD" },
			arm_a: {},
			arm_b: PELIAS_ARM,
			variable: ["engine"],
			...args,
		},
		{
			createExternalClient: (arm: ExternalArm) =>
				new ExternalGeocoderClient(arm.engine, arm.endpoint, { axios: transport.axios }),
			runStoreDir: RUN_STORE.path,
		}
	)) as Promise<Record<string, unknown>>
}

describe("mwdev_compare — external arm", () => {
	it("grades on distance to the truth coordinate and reports every threshold", async () => {
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [
			{ body: peliasBody(ANDORRA_LA_VELLA) },
			{ body: peliasBody(LES_ESCALDES) },
		])

		expect(result["grade_mode"]).toBe("truth")
		expect(result["n_graded"]).toBe(2)

		const thresholds = result["thresholds"] as Record<string, { a: number; b: number; of: number }>

		// Arm A answers Andorra la Vella for both rows: a hit on row 1, ~1.4km away on row 2 — inside 5km, outside 1km.
		expect(thresholds["1km"]!.a).toBe(1)
		expect(thresholds["5km"]!.a).toBe(2)
		// Arm B answers each row's own truth point, so it hits at every threshold.
		expect(thresholds["1km"]!.b).toBe(2)
		expect(thresholds["25km"]!.b).toBe(2)
	})

	it("states the parity verdict as a TOST against the pre-registered bound, not as two percentages", async () => {
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [
			{ body: peliasBody(ANDORRA_LA_VELLA) },
			{ body: peliasBody(LES_ESCALDES) },
		])

		const equivalence = result["equivalence"] as { equivalent: boolean; bound_pp: number; sentence: string }

		expect(equivalence.bound_pp).toBe(5)
		expect(equivalence.equivalent).toBe(false)
		expect(String(result["summary"])).toContain("±5pp @25km")
	})

	it("marks a cross-engine delta as unattributable however carefully the caller declared it", async () => {
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [
			{ body: peliasBody(ANDORRA_LA_VELLA) },
			{ body: peliasBody(ANDORRA_LA_VELLA) },
		])

		expect(result["variable_isolation"]).toBe("cross_engine")
		expect((result["warnings"] as string[]).join(" ")).toContain("different indexes")
		expect(result["mechanism_fired_on"]).toBeNull()
	})

	it("counts an empty answer as a miss WITH its reason, separately from a query failure", async () => {
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [
			{ body: peliasBody(null) },
			{ status: 500, body: { error: "boom" } },
		])

		expect(result["n_no_result_b"]).toBe(2)
		expect(result["n_errored_b"]).toBe(1)
		expect(String(result["summary"])).toContain("query FAILURES")

		const rows = result["rows_changed"] as Array<{ b: { noResultReason: string | null } }>

		expect(rows.some((row) => row.b.noResultReason?.includes("no features"))).toBe(true)
	})

	it("reports the truth's own precision, so a sub-kilometre column is not read as a rooftop claim", async () => {
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [
			{ body: peliasBody(ANDORRA_LA_VELLA) },
			{ body: peliasBody(LES_ESCALDES) },
		])

		expect(result["truth_precision_m"]).toEqual({ "25000": 2 })
		expect((result["warnings"] as string[]).join(" ")).toContain("truth tolerance coarser than 1km")
	})

	it('keeps identity tri-state: an external arm states none, so rows are incomparable — never "same"', async () => {
		// The DIVERGED coordinates guarantee rows land in rows_changed, so the absence assertion below
		// inspects real rows rather than an empty list. The stub mailwoman arm states place_ids
		// (registryAt's hierarchy carries wof:101); Pelias structurally cannot.
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [
			{ body: peliasBody(LES_ESCALDES) },
			{ body: peliasBody(ANDORRA_LA_VELLA) },
		])

		const rows = result["rows_changed"] as Array<{ identity_differed?: boolean }>

		for (const row of rows) {
			expect(row.identity_differed).toBeUndefined()
		}

		const identity = result["identity_changed"] as { n: number; of_comparable: number }

		expect(identity.of_comparable).toBe(0)
		expect(identity.n).toBe(0)
	})

	it("refuses to grade a set with no truth when grading was explicitly asked for", async () => {
		await expect(
			comparison(registryAt(ANDORRA_LA_VELLA), [{ body: peliasBody(ANDORRA_LA_VELLA) }], {
				inputs: { kind: "literal", inputs: ["Andorra la Vella"], why: "a set with no truth" },
				grade: "truth",
			})
		).rejects.toThrow(/no row in this set carries a truth coordinate/)
	})

	it("withholds a verdict rather than grading a set with no truth", async () => {
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [{ body: peliasBody(ANDORRA_LA_VELLA) }], {
			inputs: { kind: "literal", inputs: ["Andorra la Vella"], why: "a set with no truth" },
		})

		expect(result["grade_mode"]).toBe("diff-only")
		expect(result["verdict"]).toBeNull()
		expect(String(result["verdict_withheld_reason"])).toContain("no other grading axis")
	})

	it("carries the pre-registered protocol into the result rather than leaving it implied", async () => {
		const result = await comparison(registryAt(ANDORRA_LA_VELLA), [{ body: peliasBody(ANDORRA_LA_VELLA) }])
		const protocol = result["protocol"] as Record<string, unknown>

		expect(protocol["top_n"]).toBe(1)
		expect(protocol["thresholds_km"]).toEqual([1, 5, 25])
		expect(protocol["no_result_is_a_miss"]).toBe(true)
	})
})

describe("mwdev_compare — an external arm that stops answering", () => {
	it("abandons the run rather than scoring the remaining rows as misses", async () => {
		// The pre-registered protocol counts a query failure as a miss, which is right per row and wrong for a service
		// that died mid-run: the arm would lose a benchmark it stopped playing, and the result would look ordinary.
		const dead = { throws: { message: "socket hang up", code: "ERR_NETWORK" } }

		const transport = stubTransport([{ status: 200, body: "status: ok" }, { body: peliasBody(ANDORRA_LA_VELLA) }, dead])

		await expect(
			runCompare(
				registryAt(ANDORRA_LA_VELLA),
				{
					inputs: {
						kind: "literal",
						inputs: ["one", "two", "three", "four", "five", "six", "seven"],
						why: "enough rows to cross the consecutive-failure ceiling",
					},
					arm_a: {},
					arm_b: PELIAS_ARM,
					variable: ["engine"],
				},
				{
					createExternalClient: (arm: ExternalArm) =>
						new ExternalGeocoderClient(arm.engine, arm.endpoint, { axios: transport.axios, retry: false }),
					runStoreDir: RUN_STORE.path,
				}
			)
		).rejects.toThrow(/failed 5 queries in a row/)
	})
})
