/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { GauntletResult } from "mailwoman/tools/eval-harness/gauntlet/harness"
import { describe, expect, it, vi } from "vitest"

import {
	armLabelFor,
	expandCandidateArms,
	type FanoutArmReading,
	readStability,
	renderFanoutRow,
	runFanout,
	uniqueLabels,
} from "#dev-mcp/fanout"
import type { buildRoutedMailwomanArm } from "#dev-mcp/routed-mailwoman-arm"
import { stubEngine, stubEngineRegistry } from "#dev-mcp/test/stub-registry"

const LAKE = { lat: 51.5195735, lon: -0.4897194 }
const LAKE_ARROWHEAD = { lat: 34.2483, lon: -117.1892 }

function reading(overrides: Partial<FanoutArmReading> = {}): FanoutArmReading {
	return {
		label: "a",
		components: { locality: "Uxbridge" },
		lat: LAKE.lat,
		lon: LAKE.lon,
		tier: "admin",
		grade: { source: "corpus_row", met: true, issues: [] },
		error: null,
		...overrides,
	}
}

const FAILED = { source: "corpus_row" as const, met: false, issues: ["coord 8662.63km off (tol 500m)"] }
const UNGRADED = { source: "none" as const, met: null, issues: [] }

/**
 * A gauntlet projection with only the fields the fan-out and the grader read.
 */
function gauntletResult(overrides: Partial<GauntletResult>): GauntletResult {
	return {
		components: {},
		lat: null,
		lon: null,
		tier: null,
		locality: null,
		region: null,
		country: null,
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		hierarchy: [],
		...overrides,
	} as GauntletResult
}

describe("readStability", () => {
	it("calls a row a flip when the arms grade it differently, and counts the decodes", () => {
		const stability = readStability([
			reading(),
			reading({ label: "b", components: { street: "Little Britain Lake", locality: "Uxbridge" }, grade: FAILED }),
			reading({ label: "c", components: { locality: "Uxbridge", region: "Uxbridge" }, grade: FAILED }),
		])

		expect(stability.kind).toBe("flip")
		expect(stability.decode_groups).toBe(3)
		expect(stability.modal_share).toBeCloseTo(1 / 3)
		expect(stability.stable_decode).toBe(false)
		expect(stability.grade_pattern).toEqual(["pass", "fail", "fail"])
	})

	it("calls a row stable when every arm grades it the same way, whatever the decodes", () => {
		const pass = readStability([
			reading(),
			reading({ label: "b", components: { locality: "Uxbridge", region: "England" } }),
		])

		const fail = readStability([reading({ grade: FAILED }), reading({ label: "b", grade: FAILED })])

		expect(pass.kind).toBe("stable_pass")
		expect(pass.decode_groups).toBe(2)
		expect(pass.modal_share).toBe(0.5)
		expect(fail.kind).toBe("stable_fail")
		expect(fail.stable_decode).toBe(true)
	})

	it("reads an ungraded row from its decodes alone", () => {
		const same = readStability([reading({ grade: UNGRADED }), reading({ label: "b", grade: UNGRADED })])

		expect(same.kind).toBe("ungraded")
		expect(same.stable_decode).toBe(true)
		expect(same.grade_pattern).toEqual(["ungraded", "ungraded"])
	})

	it("measures the coordinate spread between the arms that resolved one", () => {
		const spread = readStability([reading(), reading({ label: "b", ...LAKE_ARROWHEAD, grade: FAILED })])
		const single = readStability([reading(), reading({ label: "b", lat: null, lon: null, grade: FAILED })])

		expect(spread.coordinate_spread_km).toBeGreaterThan(8600)
		expect(spread.coordinate_spread_km).toBeLessThan(8700)
		expect(single.coordinate_spread_km).toBeNull()
	})

	it("keeps an errored arm out of the kind and out of a stable decode", () => {
		const stability = readStability([
			reading(),
			reading({
				label: "b",
				components: {},
				lat: null,
				lon: null,
				tier: null,
				grade: UNGRADED,
				error: "engine refused",
			}),
		])

		expect(stability.kind).toBe("stable_pass")
		expect(stability.grade_pattern).toEqual(["pass", "error"])
		expect(stability.stable_decode).toBe(false)
		expect(stability.decode_groups).toBe(1)
		expect(stability.modal_share).toBe(1)
	})

	it("reads no modal share when no arm answered", () => {
		const stability = readStability([reading({ error: "a" }), reading({ label: "b", error: "b" })])

		expect(stability.modal_share).toBeNull()
		expect(stability.kind).toBe("ungraded")
	})
})

describe("arm labels", () => {
	it("labels an arm by its weights root, calls an empty config production, and numbers the rest", () => {
		expect(armLabelFor({ label: "named", config: {} }, 0)).toBe("named")
		expect(armLabelFor({ config: { weights_cache: "/mnt/mw/candidates/v820-base" } }, 0)).toBe("v820-base")
		expect(armLabelFor({ config: {} }, 0)).toBe("production")
		expect(armLabelFor({ config: { locale: "en-GB" } }, 2)).toBe("arm-3")
	})

	it("numbers repeated labels so no two arms share a column", () => {
		const labels = uniqueLabels([
			{ label: "production", config: {} },
			{ label: "production", config: {} },
			{ label: "v820-base", config: {} },
		]).map((spec) => spec.label)

		expect(labels).toEqual(["production", "production#2", "v820-base"])
	})
})

describe("expandCandidateArms", () => {
	it("maps each name to a weights_cache arm under the data root's candidates directory", async () => {
		const arms = await expandCandidateArms(["v820-base", "v800-control-shipped"], "/mnt/mw", async () => true)

		expect(arms).toEqual([
			{ label: "v820-base", config: { weights_cache: "/mnt/mw/candidates/v820-base" } },
			{ label: "v800-control-shipped", config: { weights_cache: "/mnt/mw/candidates/v800-control-shipped" } },
		])
	})

	it("refuses a name with no root by its full path", async () => {
		await expect(
			expandCandidateArms(["v999-typo"], "/mnt/mw", async (path) => !path.endsWith("v999-typo"))
		).rejects.toThrow(/"v999-typo" has no root at \/mnt\/mw\/candidates\/v999-typo/)
	})
})

describe("renderFanoutRow", () => {
	it("puts the kind, the decode count, the spread and every arm's reading on one line", () => {
		const arms = [
			reading({ label: "shipped" }),
			reading({
				label: "v820-base",
				components: { locality: "Little Britain Lake", region: "Uxbridge" },
				...LAKE_ARROWHEAD,
				grade: FAILED,
			}),
		]

		const line = renderFanoutRow({
			id: "gb-vob-little-britain-lake",
			input: "Little Britain Lake, Uxbridge",
			country: "GB",
			arms,
			stability: readStability(arms),
		})

		expect(line).toMatch(/^gb-vob-little-britain-lake \[flip decodes 2 spread 86\d\d\.\dkm\]/)
		expect(line).toContain("shipped: locality=Uxbridge → admin pass")

		expect(line).toContain(
			"v820-base: locality=Little Britain Lake region=Uxbridge → admin FAIL coord 8662.63km off (tol 500m)"
		)
	})

	it("states an errored arm's message in its column", () => {
		const arms = [reading(), reading({ label: "b", error: "weights_cache did not take" })]

		expect(renderFanoutRow({ id: "0", input: "x", country: null, arms, stability: readStability(arms) })).toContain(
			"b: ERROR weights_cache did not take"
		)
	})
})

describe("runFanout", () => {
	const LITERAL = {
		kind: "literal" as const,
		inputs: [
			{
				input: "Little Britain Lake, Uxbridge",
				...LAKE,
				tolerance_m: 500,
				country: "GB",
				components: { locality: "Uxbridge" },
			},
		],
		why: "one graded row",
	}

	/**
	 * Two arms that read the same row differently: the shipped reading lands on the truth
	 * and the candidate reading lands on another continent.
	 */
	function registryWithTwoReadings(digestFor: (config: Record<string, unknown>) => string = () => "tree0") {
		return stubEngineRegistry({
			acquire: async (config) =>
				stubEngine({
					engineID: config.weights_cache ? "engine-candidate" : "engine-shipped",
					fingerprint: { digest: digestFor(config as Record<string, unknown>) },
					session: {
						geocode: async () => ({
							result: config.weights_cache
								? {
										components: { locality: "Little Britain Lake", region: "Uxbridge" },
										locality: "Little Britain Lake",
										region: "Uxbridge",
										...LAKE_ARROWHEAD,
										resolution_tier: "admin",
										hierarchy: [],
									}
								: {
										components: { locality: "Uxbridge" },
										locality: "Uxbridge",
										...LAKE,
										resolution_tier: "admin",
										hierarchy: [],
									},
						}),
					},
				}),
		})
	}

	it("runs a literal set through two session arms and lists the flip", async () => {
		const report = await runFanout(registryWithTwoReadings(), {
			inputs: LITERAL,
			arms: [{ config: {} }, { config: { weights_cache: "/mnt/mw/candidates/v820-base" } }],
			execution_path: "single-config",
		})

		expect(report.n_arms).toBe(2)
		expect(report.provenance.arms.map((arm) => arm.label)).toEqual(["production", "v820-base"])
		expect(report.rows[0]!.stability.kind).toBe("flip")
		expect(report.rows[0]!.arms.map((arm) => arm.grade.met)).toEqual([true, false])
		expect(report.flip_set).toEqual({ n: 1, row_ids: ["0"], row_ids_omitted: 0 })

		expect(report.by_arm).toEqual([
			{ label: "production", graded: 1, passed: 1, errored: 0 },
			{ label: "v820-base", graded: 1, passed: 0, errored: 0 },
		])

		expect(report.summary).toContain("Flip set: 1 row(s) — 0.")
		expect(report.summary).toContain("production 1/1, v820-base 0/1")
		expect(report.rows[0]!.rendered).toContain("v820-base: locality=Little Britain Lake region=Uxbridge → admin FAIL")
	})

	it("expands candidates through the injected filesystem and refuses fewer than two arms", async () => {
		const registry = registryWithTwoReadings()

		const report = await runFanout(
			registry,
			{ inputs: LITERAL, candidates: ["v820-base"], arms: [{ config: {} }], execution_path: "single-config" },
			{ dataRoot: "/mnt/mw", pathExists: async () => true }
		)

		expect(report.provenance.arms[1]).toMatchObject({
			label: "v820-base",
			config: { weights_cache: "/mnt/mw/candidates/v820-base" },
		})

		await expect(
			runFanout(registry, { inputs: LITERAL, arms: [{ config: {} }], execution_path: "single-config" })
		).rejects.toThrow(/at least two arms; 1 given/)
	})

	it("refuses arms built against different source trees", async () => {
		const registry = registryWithTwoReadings((config) => (config["weights_cache"] ? "tree1" : "tree0"))

		await expect(
			runFanout(registry, {
				inputs: LITERAL,
				arms: [{ config: {} }, { config: { weights_cache: "/mnt/mw/candidates/v820-base" } }],
				execution_path: "single-config",
			})
		).rejects.toThrow(/different source trees \(tree0, tree1\)/)
	})

	it("opens each session arm as its pass begins, so an arm's engine is never evicted before its rows run", async () => {
		const events: string[] = []

		const registry = stubEngineRegistry({
			acquire: async (config) => {
				const label = config.weights_cache ? config.weights_cache.split("/").at(-1)! : "production"

				events.push(`acquire ${label}`)

				return stubEngine({
					engineID: `engine-${label}`,
					session: {
						geocode: async (input: string) => {
							events.push(`${label} ${input}`)

							return { result: { components: {}, lat: null, lon: null, resolution_tier: null, hierarchy: [] } }
						},
					},
				})
			},
		})

		await runFanout(
			registry,
			{
				inputs: { kind: "literal", inputs: ["A", "B"], why: "two rows, three arms" },
				arms: [{ config: {} }],
				candidates: ["v800-p000", "v820-base"],
				execution_path: "single-config",
			},
			{ dataRoot: "/mnt/mw", pathExists: async () => true }
		)

		expect(events).toEqual([
			"acquire production",
			"production A",
			"production B",
			"acquire v800-p000",
			"v800-p000 A",
			"v800-p000 B",
			"acquire v820-base",
			"v820-base A",
			"v820-base B",
		])
	})

	it("builds one routed arm per spec over the selected rows and disposes each", async () => {
		const disposed: string[] = []

		const build = vi.fn<typeof buildRoutedMailwomanArm>(async (config, inputs) => ({
			provenance: {
				engine: "mailwoman:gauntlet-routed" as const,
				weights_cache: config.weights_cache ?? null,
				base_model_path: "/stub/en-us/model.onnx",
				routes: Object.fromEntries(inputs.map((input) => [input.country ?? "??", "en-US"])),
				artifacts_by_locale: [],
			},
			geocode: async () =>
				gauntletResult(
					config.weights_cache
						? {
								components: { street: "Little Britain Lake", locality: "Uxbridge" },
								street: "Little Britain Lake",
								locality: "Uxbridge",
								...LAKE_ARROWHEAD,
								tier: "street",
							}
						: { components: { locality: "Uxbridge" }, locality: "Uxbridge", ...LAKE, tier: "admin" }
				),
			[Symbol.dispose]: () => {
				disposed.push(config.weights_cache ?? "production")
			},
		}))

		const report = await runFanout(
			stubEngineRegistry(),
			{ inputs: LITERAL, arms: [{ config: {} }, { config: { weights_cache: "/mnt/mw/candidates/v820-base" } }] },
			{ buildRoutedMailwomanArm: build }
		)

		expect(build).toHaveBeenCalledTimes(2)
		expect(build.mock.calls[0]![1]).toHaveLength(1)
		expect(report.provenance.execution_path).toBe("board-routed")

		expect(report.provenance.arms[0]!.provenance).toMatchObject({
			engine: "mailwoman:gauntlet-routed",
			weights_cache: null,
			routes: { GB: "en-US" },
		})

		expect(report.provenance.arms[1]!.provenance).toMatchObject({ weights_cache: "/mnt/mw/candidates/v820-base" })
		expect(report.rows[0]!.stability.kind).toBe("flip")
		// The disposable stack unwinds last-in first.
		expect(disposed).toEqual(["/mnt/mw/candidates/v820-base", "production"])
	})
})
