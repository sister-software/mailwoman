import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCompare } from "@mailwoman/dev-mcp/compare"
import type { EngineConfig, EngineRegistry } from "@mailwoman/dev-mcp/engine-registry"
import type { ResolvedInput } from "@mailwoman/dev-mcp/input-sets"
import type { RoutedMailwomanArm } from "@mailwoman/dev-mcp/routed-mailwoman-arm"
import { afterAll, describe, expect, it } from "vitest"

const RUN_STORE = mkdtempSync(join(tmpdir(), "mwdev-routed-compare-"))

afterAll(() => {
	rmSync(RUN_STORE, { recursive: true, force: true })
})

function registry(): EngineRegistry {
	const fingerprint = {
		digest: "tree0",
		gitHead: "head0",
		dirtyFiles: [] as string[],
		newestMtimeMs: 0,
		newestPath: null,
		filesWalked: 1,
	}

	return {
		bootFingerprint: fingerprint,
		sourceMoved: false,
		fingerprint: () => fingerprint,
		acquire: async () => {
			throw new Error("board-routed comparisons must not acquire a single-config engine")
		},
	} as unknown as EngineRegistry
}

describe("mwdev_compare — production board routing", () => {
	it("builds both arms with every selected row and closes both arms", async () => {
		const builds: Array<{ config: EngineConfig; inputs: readonly ResolvedInput[] }> = []
		let closes = 0

		const result = (await runCompare(
			registry(),
			{
				inputs: { kind: "board", country: "AD" },
				arm_a: { kind: "mailwoman", config: {} },
				arm_b: { kind: "mailwoman", config: { weights_cache: "/candidate" } },
				variable: ["weights_cache"],
				grade: "auto",
				execution_path: "board-routed",
			},
			{
				runStoreDir: RUN_STORE,
				buildRoutedMailwomanArm: async (config, inputs): Promise<RoutedMailwomanArm> => {
					builds.push({ config, inputs })

					return {
						provenance: {
							engine: "mailwoman:gauntlet-routed",
							weights_cache: config.weights_cache ?? null,
							base_model_path: config.weights_cache ? "/candidate/model.onnx" : "/shipped/model.onnx",
							routes: { AD: "en-US" },
							artifacts_by_locale: [],
						},
						geocode: async () => ({
							components: {},
							lat: null,
							lon: null,
							tier: "admin",
							locality: null,
							region: null,
							country: null,
							postcode: null,
							house_number: null,
							street: null,
							venue: null,
							dependent_locality: null,
							unit: null,
							postcode_country_scope: null,
							hierarchy: [],
						}),
						close: () => {
							closes += 1
						},
					}
				},
			}
		)) as Record<string, unknown>

		expect(builds).toHaveLength(2)
		expect(builds[0]!.inputs).toHaveLength(2)
		expect(builds[0]!.inputs.map((input) => input.routeCountry)).toEqual(["AD", "AD"])
		expect(builds[1]!.config.weights_cache).toBe("/candidate")
		expect(closes).toBe(2)
		expect((result["provenance_b"] as Record<string, unknown>)["weights_cache"]).toBe("/candidate")
	})

	it("refuses board routing for a literal set before building an arm", async () => {
		let builds = 0

		await expect(
			runCompare(
				registry(),
				{
					inputs: { kind: "literal", inputs: ["Paris"], why: "exercise the route guard" },
					arm_a: {},
					arm_b: { weights_cache: "/candidate" },
					variable: ["weights_cache"],
					execution_path: "board-routed",
				},
				{
					runStoreDir: RUN_STORE,
					buildRoutedMailwomanArm: async () => {
						builds += 1
						throw new Error("unreachable")
					},
				}
			)
		).rejects.toThrow(/requires a board input set/)

		expect(builds).toBe(0)
	})
})
