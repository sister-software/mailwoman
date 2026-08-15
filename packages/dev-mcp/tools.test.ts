/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The compare handler's contract, driven through a stub registry so no weights load and no gazetteer opens.
 */

import { describe, expect, it } from "vitest"

import type { EngineRegistry } from "./engine-registry.ts"
import { buildToolTable, type DevTool } from "./tools.ts"

/**
 * A session whose answer is a pure function of the input, so a test can make two arms agree or disagree at will.
 */
function stubEngine(id: string, effective: Record<string, unknown>, answer: (input: string) => unknown) {
	return {
		engineID: id,
		effective,
		fingerprint: { digest: "tree0", gitHead: "head0", dirtyFiles: [] as string[] },
		buildMs: 1,
		uses: 1,
		session: {
			geocode: async (input: string) => ({
				result: {
					components: {},
					lat: null,
					lon: null,
					resolution_tier: "none",
					locality: answer(input),
					region: null,
					postcode: null,
					house_number: null,
					street: null,
					venue: null,
					dependent_locality: null,
					unit: null,
					postcode_country_scope: null,
					hierarchy: [],
				},
				timing: { total: 1 },
			}),
			close: () => undefined,
		},
	}
}

function tableWith(engines: Array<ReturnType<typeof stubEngine>>): Map<string, DevTool> {
	let call = 0

	const registry = {
		repoRoot: "/tmp/stub",
		maxResident: 2,
		size: engines.length,
		fingerprint: () => ({
			digest: "tree0",
			gitHead: "head0",
			dirtyFiles: [],
			newestMtimeMs: 0,
			newestPath: null,
			filesWalked: 1,
		}),
		acquire: async () => engines[Math.min(call++, engines.length - 1)]!,
		summaries: () => [],
		evict: () => true,
		closeAll: () => 0,
	} as unknown as EngineRegistry

	return new Map(buildToolTable({ registry, startedAt: Date.now() }).map((tool) => [tool.name, tool]))
}

const LITERAL = {
	kind: "literal" as const,
	inputs: ["one", "two", "three"],
	why: "a fixed three-input set for the handler contract",
}

describe("mwdev_compare", () => {
	it("caveats a zero-difference result, because that is also what an unfired lever looks like", async () => {
		// Learned on 2026-08-16: this tool's first real run reported "0 of 558 differed — tight enough to read as a
		// real absence" for a lever that never reached a decode. The number could not tell the two apart, so the
		// result must not be relayed as though it could.
		const same = (input: string) => input
		const tools = tableWith([stubEngine("a", { x: 1 }, same), stubEngine("b", { x: 2 }, same)])

		const result = (await tools.get("mwdev_compare")!.handler({
			inputs: LITERAL,
			arm_b: { locale: "en-GB" },
			variable: ["x"],
		})) as Record<string, unknown>

		expect((result["arms_differed_on"] as { n: number }).n).toBe(0)
		expect(result["summary"]).toContain("or the lever never ran")
		expect((result["warnings"] as string[]).join(" ")).toContain("mwdev_trace")
	})

	it("does not caveat a result that did move", async () => {
		const tools = tableWith([
			stubEngine("a", { x: 1 }, (input) => input),
			stubEngine("b", { x: 2 }, (input) => `${input}-changed`),
		])

		const result = (await tools.get("mwdev_compare")!.handler({
			inputs: LITERAL,
			arm_b: { locale: "en-GB" },
			variable: ["x"],
		})) as Record<string, unknown>

		expect((result["arms_differed_on"] as { n: number }).n).toBe(3)
		expect(result["summary"]).not.toContain("never ran")
	})

	it("withholds a verdict when the set carries no truth", async () => {
		const tools = tableWith([
			stubEngine("a", { x: 1 }, (input) => input),
			stubEngine("b", { x: 2 }, (input) => `${input}!`),
		])

		const result = (await tools.get("mwdev_compare")!.handler({
			inputs: LITERAL,
			arm_b: { locale: "en-GB" },
			variable: ["x"],
		})) as Record<string, unknown>

		expect(result["grade_mode"]).toBe("diff-only")
		expect(result["verdict"]).toBeNull()
		expect(result["verdict_withheld_reason"]).toContain("described, not graded")
	})

	it("marks attribution ambiguous when more moved than was declared", async () => {
		const tools = tableWith([
			stubEngine("a", { x: 1, y: 1 }, (input) => input),
			stubEngine("b", { x: 2, y: 2 }, (input) => input),
		])

		const result = (await tools.get("mwdev_compare")!.handler({
			inputs: LITERAL,
			arm_b: { locale: "en-GB" },
			variable: ["x"],
		})) as Record<string, unknown>

		expect(result["attribution"]).toBe("ambiguous")
		expect(result["variable_effective"]).toEqual(["x", "y"])
		expect(result["summary"]).toContain("ATTRIBUTION AMBIGUOUS")
	})

	it("refuses arms built against different source trees", async () => {
		const a = stubEngine("a", { x: 1 }, (input) => input)
		const b = stubEngine("b", { x: 2 }, (input) => input)

		b.fingerprint = { digest: "tree1", gitHead: "head1", dirtyFiles: [] }

		const tools = tableWith([a, b])

		await expect(
			tools.get("mwdev_compare")!.handler({ inputs: LITERAL, arm_b: { locale: "en-GB" }, variable: ["x"] })
		).rejects.toThrow(/different source trees/)
	})

	it("returns every changed row rather than a capped sample", async () => {
		const tools = tableWith([
			stubEngine("a", { x: 1 }, (input) => input),
			stubEngine("b", { x: 2 }, (input) => `${input}!`),
		])

		const result = (await tools.get("mwdev_compare")!.handler({
			inputs: LITERAL,
			arm_b: { locale: "en-GB" },
			variable: ["x"],
		})) as Record<string, unknown>

		expect(result["rows_changed"] as unknown[]).toHaveLength(3)
	})
})
