/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The compare handler's contract, driven through a stub registry so no weights load and no gazetteer opens.
 */

import { JobRegistry } from "@mailwoman/dev-mcp/jobs"
import { buildToolTable, type DevTool } from "@mailwoman/dev-mcp/tools"
import { describe, expect, it } from "vitest"

import { stubEngine as buildEngine, stubEngineRegistry } from "#test/stub-registry"

/**
 * A session whose answer is a pure function of the input, so a test can make two arms agree or disagree at will.
 */
function stubEngine(id: string, effective: Record<string, unknown>, answer: (input: string) => unknown) {
	return buildEngine({
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
			[Symbol.dispose]: () => undefined,
		},
	})
}

async function tableWith(engines: Array<ReturnType<typeof stubEngine>>): Promise<Map<string, DevTool>> {
	let call = 0

	const registry = stubEngineRegistry({
		size: engines.length,
		acquire: async () => engines[Math.min(call++, engines.length - 1)]!,
	})

	return new Map(
		(await buildToolTable({ registry, jobs: new JobRegistry(), startedAt: Date.now() })).map((tool) => [
			tool.name,
			tool,
		])
	)
}

const LITERAL = {
	kind: "literal" as const,
	inputs: ["one", "two", "three"],
	why: "a fixed three-input set for the handler contract",
}

describe("mwdev_job", () => {
	/**
	 * A child that prints a gauntlet-shaped log and exits 1 — what a COMPLETED run grading FAIL looks like.
	 */
	const FAIL_SCRIPT =
		'console.log("=== Gauntlet · regression (350/354 gated cases pass, 203 tracked) ===");' +
		'console.log("verdict: FAIL");process.exit(1)'

	async function runToCompletion(script: string, exitCode: number): Promise<Record<string, unknown>> {
		const jobs = new JobRegistry()

		const registry = stubEngineRegistry({ repoRoot: process.cwd() })

		const tools = new Map(
			(await buildToolTable({ registry, jobs, startedAt: Date.now() })).map((tool) => [tool.name, tool])
		)

		const job = jobs.start("probe", process.execPath, ["-e", script], process.cwd())

		await new Promise<void>((resolve) => {
			const poll = setInterval(() => {
				if (jobs.get(job.jobID)!.state !== "running") {
					clearInterval(poll)
					resolve()
				}
			}, 25)
		})

		expect(jobs.get(job.jobID)!.exitCode).toBe(exitCode)

		return (await tools.get("mwdev_job")!.handler({ action: "result", job_id: job.jobID })) as Record<string, unknown>
	}

	it("distinguishes a graded FAIL from a crash", async () => {
		// The gauntlet exits 1 on a FAIL verdict, so `state: "failed"` is what a healthy failing run looks like. Those
		// need different responses from a reader, so the difference is stated rather than inferred from an exit code.
		const result = await runToCompletion(FAIL_SCRIPT, 1)

		expect(result["state"]).toBe("failed")
		expect(result["job_outcome"]).toContain("COMPLETED and graded FAIL")
		expect(result["job_outcome"]).toContain("not a crash")
	})

	it("does not claim completion for a run that never reached a verdict", async () => {
		const result = await runToCompletion('console.error("boom");process.exit(1)', 1)

		expect(result["state"]).toBe("failed")
		expect(result["job_outcome"]).toBeUndefined()
		expect((result["report"] as { unparsed: string[] }).unparsed.join(" ")).toContain("did not reach a verdict")
	})

	it("lists jobs and reports a partial result while one is still running", async () => {
		const jobs = new JobRegistry()
		const registry = stubEngineRegistry({ repoRoot: process.cwd() })

		const tools = new Map(
			(await buildToolTable({ registry, jobs, startedAt: Date.now() })).map((tool) => [tool.name, tool])
		)

		const job = jobs.start("slow", process.execPath, ["-e", "setTimeout(() => {}, 30000)"], process.cwd())

		const listed = (await tools.get("mwdev_job")!.handler({ action: "list" })) as { jobs: unknown[] }

		expect(listed.jobs).toHaveLength(1)

		const partial = (await tools.get("mwdev_job")!.handler({
			action: "result",
			job_id: job.jobID,
		})) as Record<string, unknown>

		expect(partial["partial"]).toBe(true)
		expect(partial["summary"]).toContain("Still running")

		expect(jobs.cancel(job.jobID)).toBe(true)
	})
})

describe("mwdev_compare", () => {
	it("refuses identical engine ids when the declared variable is an EngineConfig key", async () => {
		const same = (input: string) => input

		const tools = await tableWith([
			stubEngine("same", { locale: "en-US" }, same),
			stubEngine("same", { locale: "en-US" }, same),
		])

		await expect(
			tools.get("mwdev_compare")!.handler({
				inputs: LITERAL,
				arm_b: { locale: "en-US" },
				variable: ["locale"],
			})
		).rejects.toThrow(/both arms resolved to engine same/)
	})

	it("caveats a zero-difference result, because that is also what an unfired lever looks like", async () => {
		// Learned on 2026-08-16: this tool's first real run reported "0 of 558 differed — tight enough to read as a
		// real absence" for a lever that never reached a decode. The number could not tell the two apart, so the
		// result must not be relayed as though it could.
		const same = (input: string) => input
		const tools = await tableWith([stubEngine("a", { x: 1 }, same), stubEngine("b", { x: 2 }, same)])

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
		const tools = await tableWith([
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
		const tools = await tableWith([
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

	it("marks isolation ambiguous when more moved than was declared", async () => {
		const tools = await tableWith([
			stubEngine("a", { x: 1, y: 1 }, (input) => input),
			stubEngine("b", { x: 2, y: 2 }, (input) => input),
		])

		const result = (await tools.get("mwdev_compare")!.handler({
			inputs: LITERAL,
			arm_b: { locale: "en-GB" },
			variable: ["x"],
		})) as Record<string, unknown>

		expect(result["variable_isolation"]).toBe("ambiguous")
		expect(result["variable_effective"]).toEqual(["x", "y"])
		expect(result["summary"]).toContain("VARIABLE ISOLATION AMBIGUOUS")
	})

	it("refuses arms built against different source trees", async () => {
		const a = stubEngine("a", { x: 1 }, (input) => input)
		const b = stubEngine("b", { x: 2 }, (input) => input)

		b.fingerprint = { ...b.fingerprint, digest: "tree1", gitHead: "head1" }

		const tools = await tableWith([a, b])

		await expect(
			tools.get("mwdev_compare")!.handler({ inputs: LITERAL, arm_b: { locale: "en-GB" }, variable: ["x"] })
		).rejects.toThrow(/different source trees/)
	})

	it("returns every changed row rather than a capped sample", async () => {
		const tools = await tableWith([
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
