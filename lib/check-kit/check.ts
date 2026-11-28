// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwops check`'s library half: run a registered check, waiting for the host first
 * when the check is heavy, and run the direct-push preflight set.
 */

import { acquireHost, describeHolder, type HostAcquisition, HostLoad, type HostServices } from "#check-kit/host"
import { type CheckCommand, findCheckCommand, PREFLIGHT_CHECKS } from "#check-kit/registry"
import { type CheckRun, runCheck, type RunCheckOptions } from "#check-kit/runner"

/**
 * The exit status `mwops check` returns when the host lock wait expired and the check never started.
 *
 * It is `EX_TEMPFAIL` from `sysexits.h`, which no wrapped script returns.
 */
export const HOST_BUSY_EXIT = 75

/**
 * A registered check's result: its run, or why it never started, with what it waited for.
 */
export interface CheckResult {
	check: string
	ran: boolean
	/**
	 * The host wait of a heavy check, or `null` for a check that takes no lock.
	 */
	host: Omit<HostAcquisition, "lock"> | null
	run: CheckRun | null
	/**
	 * The status `mwops check` exits with: the check's own, or {@link HOST_BUSY_EXIT}.
	 */
	exitCode: number
	summary: string
}

/**
 * Options for {@link runRegisteredCheck}.
 */
export interface RegisteredCheckOptions extends Omit<RunCheckOptions, "paths"> {
	maxWaitMs: number
	noWait: boolean
	/**
	 * Run without taking the host lock, because the caller already holds it.
	 */
	hostHeld?: boolean
	host?: HostServices
}

/**
 * One line that states the exit status and what the parser read.
 */
function summarizeRun(run: CheckRun): string {
	const status = run.exitCode === null ? `killed by ${run.signal}` : `exit ${run.exitCode}`
	const { parsed } = run

	if (!parsed.parsed) return `${run.check}: ${status}; output unparsed: ${parsed.reason}`

	const parts = [`${parsed.errors} error(s)`, `${parsed.warnings} warning(s)`]

	if (parsed.totals) {
		const { files, tests } = parsed.totals

		parts.unshift(
			`files ${files.passed} passed, ${files.failed} failed, ${files.skipped} skipped of ${files.total}`,
			`tests ${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped of ${tests.total}`
		)
	}

	if (parsed.failingChecks.length) {
		parts.push(`failing: ${parsed.failingChecks.join(", ")}`)
	}

	return `${run.check}: ${status}; ${parts.join("; ")}`
}

function exitCodeOf(run: CheckRun): number {
	if (typeof run.exitCode === "number") return run.exitCode

	// A signal ended the command, so it can't have passed.
	return 1
}

/**
 * Run a check, waiting for the host lock when it is heavy.
 */
export async function runRegisteredCheck(
	check: CheckCommand,
	paths: readonly string[],
	options: RegisteredCheckOptions
): Promise<CheckResult> {
	if (check.hostLoad === HostLoad.Light || options.hostHeld) {
		const run = await runCheck(check, { ...options, paths })

		return { check: check.name, ran: true, host: null, run, exitCode: exitCodeOf(run), summary: summarizeRun(run) }
	}

	const acquired = await acquireHost(
		{ check: check.name, checkout: options.checkout, paths },
		options.maxWaitMs,
		options.noWait,
		options.host
	)

	const { lock, ...host } = acquired

	if (!lock) {
		const holder = host.lockWait.holder ? describeHolder(host.lockWait.holder) : "an owner whose record is unreadable"

		const bound = options.noWait
			? "--no-wait was given"
			: `the ${Math.round(options.maxWaitMs / 60_000)}-minute bound expired`

		return {
			check: check.name,
			ran: false,
			host,
			run: null,
			exitCode: HOST_BUSY_EXIT,
			summary: `${check.name}: not run; ${bound} while ${holder} held the host lock`,
		}
	}

	await using _lock = lock

	const run = await runCheck(check, { ...options, paths })

	return { check: check.name, ran: true, host, run, exitCode: exitCodeOf(run), summary: summarizeRun(run) }
}

/**
 * Human lines for a result: the summary, the failing tests or checks, then the log path.
 */
export function renderCheckResult(result: CheckResult): string[] {
	const lines = [result.summary]

	for (const message of result.host?.lockWait.staleReleased ?? []) {
		lines.push(`  ${message}`)
	}

	const run = result.run

	if (!run) return lines

	for (const test of run.parsed.failingTests) {
		lines.push(`  FAIL ${test.file}${test.name ? ` > ${test.name}` : ""}`)

		if (test.firstErrorLine) {
			lines.push(`       ${test.firstErrorLine}`)
		}
	}

	if (!run.parsed.failingTests.length) {
		for (const line of run.parsed.errorLines) {
			lines.push(`  ${line}`)
		}
	}

	lines.push(`log: ${run.logPath}`)

	return lines
}

/**
 * One preflight command's line: the command and its exit status, as a push commit message states it.
 */
interface PreflightLine {
	check: string
	commandLine: string
	exitCode: number
	summary: string
	logPath: string | null
}

/**
 * The preflight set's result.
 */
export interface PreflightResult {
	passed: boolean
	host: Omit<HostAcquisition, "lock"> | null
	results: CheckResult[]
	lines: PreflightLine[]
	/**
	 * What the set leaves out, stated so a reader doesn't take the set for the whole instruction.
	 */
	omitted: string[]
}

/**
 * Run the direct-push preflight set in order, every check even after one fails, under one host lock.
 */
export async function runPreflight(
	options: Omit<RegisteredCheckOptions, "hostHeld" | "argsOverride">
): Promise<PreflightResult> {
	const omitted = [
		"The integration suites of the workspaces a push touches: `mwops ci-scope` selects suites from a GitHub event, not from a local diff.",
	]

	const acquired = await acquireHost(
		{ check: "preflight", checkout: options.checkout },
		options.maxWaitMs,
		options.noWait,
		options.host
	)

	const { lock, ...host } = acquired

	if (!lock) return { passed: false, host, results: [], lines: [], omitted }

	await using _lock = lock

	const results: CheckResult[] = []
	const lines: PreflightLine[] = []

	for (const name of PREFLIGHT_CHECKS) {
		const check = findCheckCommand(name)!
		const result = await runRegisteredCheck(check, [], { ...options, hostHeld: true })

		results.push(result)

		// The script as `AGENTS.md` names it, without the reporter flags the runner adds.
		lines.push({
			check: name,
			commandLine: `yarn ${check.args.join(" ")}`,
			exitCode: result.exitCode,
			summary: result.summary,
			logPath: result.run?.logPath ?? null,
		})
	}

	return { passed: results.every((result) => result.exitCode === 0), host, results, lines, omitted }
}
