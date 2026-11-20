// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwops worktree prepare`'s library half: read a tree's status, run the steps that
 * fix what it lacks under one host lock, then read the status again.
 *
 * Each step is a check command run by the check runner in the target tree, so it runs that
 * tree's own `yarn` and, for `copy-weights`, the tree's own `lib/ops-cli/cli.ts`.
 * A failing step stops the sequence.
 */

import { OperationEffect } from "@mailwoman/core/scripting"

import { type CheckResult, HOST_BUSY_EXIT, type RegisteredCheckOptions, runRegisteredCheck } from "#check-kit/check"
import { acquireHost, describeHolder, type HostAcquisition, type HostServices } from "#check-kit/host"
import { parseWeightsCopyOutput, parseYarnInstallOutput } from "#check-kit/parsers/prepare-steps"
import { type CheckCommand, CheckReader, findCheckCommand } from "#check-kit/registry"
import {
	PREPARE_STEP_ORDER,
	PrepareStep,
	PrerequisiteState,
	readWorktreeStatus,
	type WorktreeStatus,
	type WorktreeStatusOptions,
} from "#check-kit/worktree/status"

/**
 * The check command each step runs.
 *
 * `install` and `copy-weights` aren't repository checks, so they're defined here
 * rather than in the registry, and `compile` is the registered check.
 */
const PREPARE_STEP_COMMANDS: Readonly<Record<PrepareStep, CheckCommand>> = {
	[PrepareStep.Install]: {
		name: PrepareStep.Install,
		description: "yarn install --json: install the tree's dependencies, with Yarn's typed output lines",
		effect: OperationEffect.LocalWrite,
		heavy: true,
		takesPaths: false,
		args: ["install", "--json"],
		reader: CheckReader.Script,
		parse: parseYarnInstallOutput,
	},
	[PrepareStep.Compile]: findCheckCommand("compile")!,
	[PrepareStep.CopyWeights]: {
		name: PrepareStep.CopyWeights,
		description: "yarn mwops release copy-weights: materialize the weights workspaces with the tree's own mwops",
		effect: OperationEffect.LocalWrite,
		heavy: true,
		takesPaths: false,
		args: ["mwops", "release", "copy-weights"],
		reader: CheckReader.Script,
		parse: parseWeightsCopyOutput,
	},
}

/**
 * How a step ended.
 */
const StepOutcome = {
	/**
	 * The step ran and exited 0.
	 */
	Passed: "passed",
	Failed: "failed",
	/**
	 * The status read before the run found its prerequisite satisfied.
	 */
	Skipped: "skipped",
	/**
	 * An earlier step failed, so this one never started.
	 */
	NotReached: "not-reached",
	/**
	 * Under `--dry-run`, the step would have run.
	 */
	WouldRun: "would-run",
} as const

type StepOutcome = (typeof StepOutcome)[keyof typeof StepOutcome]

/**
 * One step's line in the result.
 */
interface PrepareStepResult {
	step: PrepareStep
	outcome: StepOutcome
	/**
	 * The command the step runs in the target tree.
	 */
	commandLine: string
	/**
	 * The status evidence that selected or skipped the step.
	 */
	evidence: string
	/**
	 * The check result for a step that ran, with its command, exit status, duration and log path.
	 */
	result: CheckResult | null
	/**
	 * The first run of a compile step that ran twice, with the reason it ran again, or `null`.
	 */
	retry: { reason: string; firstAttempt: CheckResult } | null
}

/**
 * A TypeScript error that a module lacks an export, against a workspace package or a `#` import.
 */
const STALE_DECLARATION_ERROR = /error TS(?:2305|2724): (?:Module )?'"(?:@mailwoman\/|#)[^"]+"' has no exported member/u

/**
 * Why a failed compile runs once more, or `null` when it doesn't.
 *
 * TypeScript 7's `tsc -b` has failed a first build after a rebase that added exports to
 * `@mailwoman/core`, with every missing-export error naming a module whose declaration
 * the same build rewrote, and passed a second build with no source change.
 * The cause isn't established, so the retry is limited to a failure whose errors include a missing
 * export from a workspace module, and the result records the first run.
 */
function compileRetryReason(result: CheckResult): string | null {
	const lines = result.run?.parsed.errorLines ?? []
	const stale = lines.filter((line) => STALE_DECLARATION_ERROR.test(line))

	if (!stale.length) return null

	return (
		`the first compile exited ${result.exitCode} with ${stale.length} missing-export error(s) against a workspace ` +
		`module, the form a build reading declarations it hadn't yet rewritten produced; first: ${stale[0]}`
	)
}

/**
 * Which steps a status calls for: each step whose prerequisite isn't satisfied, in order.
 *
 * An unread prerequisite calls for its step, because the step is the repair
 * and the reading established neither state.
 */
function selectPrepareSteps(status: Pick<WorktreeStatus, "prerequisites">): PrepareStep[] {
	return PREPARE_STEP_ORDER.filter((step) => status.prerequisites[step].state !== PrerequisiteState.Satisfied)
}

/**
 * Runs one step's command in the target tree, with the host lock already held.
 */
type PrepareStepRunner = (command: CheckCommand, tree: string) => Promise<CheckResult>

/**
 * Options for {@link runPrepare}.
 */
export interface PrepareOptions extends WorktreeStatusOptions {
	dryRun: boolean
	maxWaitMs: number
	noWait: boolean
	logDirectory?: string
	host?: HostServices
	/**
	 * Replaced by a test so no real install runs.
	 */
	runStep?: PrepareStepRunner
	/**
	 * Replaced by a test.
	 */
	readStatus?: (path: string, options: WorktreeStatusOptions) => Promise<WorktreeStatus>
}

/**
 * The result of `mwops worktree prepare`.
 */
export interface PrepareResult {
	tree: string
	dryRun: boolean
	before: WorktreeStatus
	steps: PrepareStepResult[]
	/**
	 * The status read after the last step, or `null` under `--dry-run` or when the host lock wait expired.
	 */
	after: WorktreeStatus | null
	/**
	 * The host wait, or `null` when no step ran.
	 */
	host: Omit<HostAcquisition, "lock"> | null
	ready: boolean
	exitCode: number
	summary: string
}

function commandLineOf(command: CheckCommand): string {
	return `yarn ${command.args.join(" ")}`
}

function defaultStepRunner(options: Omit<RegisteredCheckOptions, "checkout" | "hostHeld">): PrepareStepRunner {
	return (command, tree) => runRegisteredCheck(command, [], { ...options, checkout: tree, hostHeld: true })
}

/**
 * Run the steps in `selected` in order and stop at the first that fails.
 *
 * Every step of {@link PREPARE_STEP_ORDER} gets a line: run, skipped with its evidence, or not reached.
 */
async function runPrepareSteps(
	before: WorktreeStatus,
	selected: readonly PrepareStep[],
	runStep: PrepareStepRunner
): Promise<PrepareStepResult[]> {
	const steps: PrepareStepResult[] = []
	let failed = false

	for (const step of PREPARE_STEP_ORDER) {
		const command = PREPARE_STEP_COMMANDS[step]
		const base = { step, commandLine: commandLineOf(command), evidence: before.prerequisites[step].evidence }

		if (!selected.includes(step)) {
			steps.push({ ...base, outcome: StepOutcome.Skipped, result: null, retry: null })

			continue
		}

		if (failed) {
			steps.push({ ...base, outcome: StepOutcome.NotReached, result: null, retry: null })

			continue
		}

		let result = await runStep(command, before.tree)
		let retry: PrepareStepResult["retry"] = null
		const reason = step === PrepareStep.Compile && result.exitCode !== 0 ? compileRetryReason(result) : null

		if (reason) {
			retry = { reason, firstAttempt: result }
			result = await runStep(command, before.tree)
		}

		failed = result.exitCode !== 0
		steps.push({ ...base, outcome: failed ? StepOutcome.Failed : StepOutcome.Passed, result, retry })
	}

	return steps
}

function summarizePrepare(result: Omit<PrepareResult, "summary" | "exitCode">): string {
	const ran = result.steps.filter((step) => step.result)
	const failed = result.steps.find((step) => step.outcome === StepOutcome.Failed)

	if (result.dryRun) {
		const wouldRun = result.steps.filter((step) => step.outcome === StepOutcome.WouldRun).map((step) => step.step)

		return wouldRun.length
			? `dry run: prepare would run ${wouldRun.join(", then ")} in ${result.tree}`
			: `dry run: ${result.tree} is ready, so prepare would run nothing`
	}

	const after = result.after ? result.after.summary : "the status after was not read"

	if (failed) return `${failed.step} failed with exit ${failed.result?.exitCode}; ${after}`

	return `ran ${ran.length} step(s)${ran.length ? ` (${ran.map((step) => step.step).join(", ")})` : ""}; ${after}`
}

/**
 * Prepare the working tree that contains `path`.
 */
export async function runPrepare(path: string, options: PrepareOptions): Promise<PrepareResult> {
	const readStatus = options.readStatus ?? readWorktreeStatus
	const statusOptions: WorktreeStatusOptions = { callingCheckout: options.callingCheckout, base: options.base }
	const before = await readStatus(path, statusOptions)
	const selected = selectPrepareSteps(before)
	const tree = before.tree

	const finish = (partial: Omit<PrepareResult, "summary" | "exitCode">, busy = false): PrepareResult => ({
		...partial,
		exitCode: busy ? HOST_BUSY_EXIT : partial.ready ? 0 : 1,
		summary: summarizePrepare(partial),
	})

	if (options.dryRun) {
		const steps = PREPARE_STEP_ORDER.map((step) => ({
			step,
			outcome: selected.includes(step) ? StepOutcome.WouldRun : StepOutcome.Skipped,
			commandLine: commandLineOf(PREPARE_STEP_COMMANDS[step]),
			evidence: before.prerequisites[step].evidence,
			result: null,
			retry: null,
		}))

		return finish({ tree, dryRun: true, before, steps, after: null, host: null, ready: before.ready })
	}

	if (!selected.length) {
		const steps = await runPrepareSteps(before, selected, () => {
			throw new Error("no step was selected")
		})

		const after = await readStatus(path, statusOptions)

		return finish({ tree, dryRun: false, before, steps, after, host: null, ready: after.ready })
	}

	const acquired = await acquireHost(
		{ check: "worktree-prepare", checkout: tree, steps: selected },
		options.maxWaitMs,
		options.noWait,
		options.host
	)

	const { lock, ...host } = acquired

	if (!lock) {
		const holder = host.lockWait.holder ? describeHolder(host.lockWait.holder) : "an owner whose record is unreadable"

		const steps = PREPARE_STEP_ORDER.map((step) => ({
			step,
			outcome: selected.includes(step) ? StepOutcome.NotReached : StepOutcome.Skipped,
			commandLine: commandLineOf(PREPARE_STEP_COMMANDS[step]),
			evidence: `${before.prerequisites[step].evidence}${selected.includes(step) ? `; not run, because ${holder} held the host lock` : ""}`,
			result: null,
			retry: null,
		}))

		return finish({ tree, dryRun: false, before, steps, after: null, host, ready: false }, true)
	}

	await using _lock = lock

	const runStep =
		options.runStep ??
		defaultStepRunner({
			maxWaitMs: options.maxWaitMs,
			noWait: options.noWait,
			logDirectory: options.logDirectory,
			host: options.host,
		})

	const steps = await runPrepareSteps(before, selected, runStep)
	const after = await readStatus(path, statusOptions)

	// A failed step leaves the tree unprepared whatever the status after reads.
	const passed = steps.every((step) => step.outcome !== StepOutcome.Failed)

	return finish({ tree, dryRun: false, before, steps, after, host, ready: passed && after.ready })
}

/**
 * The result as lines: the summary, one line per step, then the status after.
 */
export function renderPrepareResult(result: PrepareResult): string[] {
	const lines = [result.summary]

	for (const step of result.steps) {
		const run = step.result?.run

		const detail = run
			? `exit ${run.exitCode ?? `signal ${run.signal}`} in ${Math.round(run.durationMs / 1000)} s; log: ${run.logPath}`
			: step.evidence

		lines.push(`  ${step.step} ${step.outcome}: ${step.commandLine}; ${detail}`)

		if (step.retry) {
			lines.push(
				`    ran again, because ${step.retry.reason}; first run's log: ${step.retry.firstAttempt.run?.logPath}`
			)
		}
	}

	return lines
}
