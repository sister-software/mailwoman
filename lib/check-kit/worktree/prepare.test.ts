// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Step selection and sequencing, with an injected status reader and step runner
 * so each step returns a fixed result.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterAll, describe, expect, it } from "vitest"

import type { CheckResult } from "#check-kit/check"
import type { CheckCommand } from "#check-kit/registry"
import type { CheckRun } from "#check-kit/runner"
import { runPrepare } from "#check-kit/worktree/prepare"
import { PrerequisiteState, type PrepareStep, type WorktreeStatus } from "#check-kit/worktree/status"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A status whose listed steps are missing and whose others are satisfied.
 */
function statusWith(missing: readonly PrepareStep[], unread: readonly PrepareStep[] = []): WorktreeStatus {
	const prerequisite = (step: PrepareStep) =>
		unread.includes(step)
			? { state: PrerequisiteState.Unread, evidence: `${step} unread`, detail: null }
			: missing.includes(step)
				? { state: PrerequisiteState.Missing, evidence: `${step} missing`, detail: null }
				: { state: PrerequisiteState.Satisfied, evidence: `${step} satisfied`, detail: null }

	const blocking = [...missing, ...unread]

	return {
		requestedPath: "/tree",
		tree: "/tree",
		branch: { read: false, reason: "test" },
		prerequisites: {
			install: prerequisite("install"),
			compile: prerequisite("compile"),
			"copy-weights": prerequisite("copy-weights"),
		},
		origin: { read: false, reason: "test" },
		environment: { path: "/tree/.env", present: { read: true, value: true }, flag: null },
		ready: !blocking.length,
		missing: (["install", "compile", "copy-weights"] as const).filter((step) => blocking.includes(step)),
		summary: "test status",
	} as WorktreeStatus
}

function result(command: CheckCommand, exitCode: number, errorLines: string[] = []): CheckResult {
	const run = { logPath: `/logs/${command.name}.log`, parsed: { errorLines } } as CheckRun

	return { check: command.name, ran: true, host: null, run, exitCode, summary: `${command.name}: exit ${exitCode}` }
}

/**
 * The first error of the compile that failed after a rebase on 2026-11-20,
 * in a worktree whose `out/` predated it.
 */
const STALE_EXPORT_ERROR =
	"lib/check-kit/host.ts(21,2): error TS2305: Module '\"@mailwoman/core/fs/lock\"' has no exported member 'staleOwnerReason'."

async function prepareWith(
	statuses: WorktreeStatus[],
	exitCodes: Record<string, number | number[]>,
	errorLines: Record<string, string[]> = {},
	dryRun = false
) {
	const lockDir = fixtures
		.use(await temporaryDirectory("worktree-prepare-lock-"))
		.path("heavy-check.lock")
		.toString()

	const ran: string[] = []
	const reads = [...statuses]

	const prepared = await runPrepare("/tree", {
		callingCheckout: "/calling",
		dryRun,
		maxWaitMs: 0,
		noWait: true,
		host: { lockDir, readCI: async () => ({ read: true, runs: [], excluded: [] }) },
		readStatus: async () => reads.shift()!,
		runStep: async (command) => {
			// A list gives the exit status of each successive run of the step.
			const codes = exitCodes[command.name] ?? 0
			const exitCode = Array.isArray(codes) ? (codes[ran.filter((name) => name === command.name).length] ?? 0) : codes

			ran.push(command.name)

			return result(command, exitCode, exitCode === 0 ? [] : (errorLines[command.name] ?? []))
		},
	})

	return { prepared, ran }
}

describe("runPrepare", () => {
	it("selects each unsatisfied step in install, compile, copy-weights order, unread ones included, and runs none under --dry-run", async () => {
		const outcomes = async (status: WorktreeStatus) => {
			const { prepared, ran } = await prepareWith([status], {}, {}, true)

			expect(ran).toEqual([])

			return prepared.steps.map((step) => step.outcome)
		}

		await expect(outcomes(statusWith(["copy-weights", "install"]))).resolves.toEqual([
			"would-run",
			"skipped",
			"would-run",
		])

		await expect(outcomes(statusWith([], ["compile"]))).resolves.toEqual(["skipped", "would-run", "skipped"])
		await expect(outcomes(statusWith([]))).resolves.toEqual(["skipped", "skipped", "skipped"])
	})

	it("runs only the missing steps, reports the satisfied one skipped with its evidence, and reads the status again", async () => {
		const { prepared, ran } = await prepareWith([statusWith(["compile", "copy-weights"]), statusWith([])], {})

		expect(ran).toEqual(["compile", "copy-weights"])

		expect(prepared.steps.map((step) => [step.step, step.outcome])).toEqual([
			["install", "skipped"],
			["compile", "passed"],
			["copy-weights", "passed"],
		])

		expect(prepared.steps[0]!.evidence).toBe("install satisfied")
		expect(prepared.after?.ready).toBe(true)
		expect(prepared.exitCode).toBe(0)
	})

	it("stops at a failing step and marks the later selected steps not reached", async () => {
		const missing = ["install", "compile", "copy-weights"] as const

		const { prepared, ran } = await prepareWith([statusWith(missing), statusWith(["compile", "copy-weights"])], {
			install: 1,
		})

		expect(ran).toEqual(["install"])
		expect(prepared.steps.map((step) => step.outcome)).toEqual(["failed", "not-reached", "not-reached"])
		expect(prepared.ready).toBe(false)
		expect(prepared.exitCode).toBe(1)
	})

	it("runs a compile that failed on a missing workspace export once more, and records the first run", async () => {
		const { prepared, ran } = await prepareWith(
			[statusWith(["compile"]), statusWith([])],
			{ compile: [2, 0] },
			{ compile: [STALE_EXPORT_ERROR] }
		)

		expect(ran).toEqual(["compile", "compile"])
		expect(prepared.steps[1]).toMatchObject({ outcome: "passed", result: { exitCode: 0 } })
		expect(prepared.steps[1]!.retry?.firstAttempt.exitCode).toBe(2)
		expect(prepared.steps[1]!.retry?.reason).toContain("staleOwnerReason")
		expect(prepared.exitCode).toBe(0)
	})

	it("doesn't rerun a compile that failed on another error, and reports not ready though the status after reads ready", async () => {
		const typeError = "lib/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."

		const { prepared, ran } = await prepareWith(
			[statusWith(["compile"]), statusWith([])],
			{ compile: 2 },
			{
				compile: [typeError],
			}
		)

		expect(ran).toEqual(["compile"])
		expect(prepared.steps[1]).toMatchObject({ outcome: "failed", retry: null })
		expect(prepared.ready).toBe(false)
		expect(prepared.exitCode).toBe(1)
	})

	it("exits non-zero when every step passed and the status after is still not ready", async () => {
		const { prepared } = await prepareWith([statusWith(["copy-weights"]), statusWith(["copy-weights"])], {})

		expect(prepared.steps.at(-1)?.outcome).toBe("passed")
		expect(prepared.exitCode).toBe(1)
	})
})
